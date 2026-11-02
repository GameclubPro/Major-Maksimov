import { resolveModerationSanctionExpiry } from '../moderation/moderation-sanction-expiry.util';
import { resolveEffectiveChatClosure } from '../moderation/night-mode-transition-time.util';
import { resolveAdminBotUserId } from './admin-bot-identity';
import { ManagedEntityPresentationService } from './managed-entity-presentation.service';
import {
  applyFormerParticipantModeration,
  hasFormerParticipantHistory,
  readLocalChatBanForRelease,
} from './former-participant-moderation';
import { assertPublisherSuggestionDeliveryReady } from './publisher-suggestion-setup-block';
import {
  advanceChatMutationOrder,
  applyGroupChatControlCommand,
  GroupCommandAuthorityService,
  type GroupCommandPermit,
  type GroupCommandResult,
} from '../common/group-command-authority.service';
import * as channelDialogValues from './admin-channel-dialog-values';
import { assertManualGroupCommandSuccessNoticeAuthority } from './admin-manual-group-command-notice-authority';
import { mergeManagedBotChatCatalogRows } from './admin-managed-bot-catalog-values';
import { createManagedEntityHeader } from './admin-managed-entity-header';
import { publishManagedEntityHeaderChanges } from './admin-managed-entity-header-refresh';
import {
  resolveManualMuteResultFromLedger,
  isAmbiguousAttemptedMaxMemberMutation,
  isManualModerationTransientMaxError,
  isRetryableManualFanoutPreparationError,
  isManualModerationOrderingFailure,
  summarizeManualModerationCleanup,
  summarizeManualMuteFanout,
  summarizeManualBanFanout,
  buildManualModerationFanoutOperationKey,
  extractHttpErrorMessage,
  escapeMarkdownPlainText,
  readObjectPayloadOrNull,
} from './admin-manual-moderation-values';
import { createManagedEntitiesRefreshState } from './admin-managed-entities-refresh-state';
import { AdminManagedEntitiesSnapshotRuntime } from './admin-managed-entities-snapshot-runtime';
import { mergeManagedEntityGroups } from './admin-managed-entities-snapshot-codec';
import { toSafeInteger, toIsoString } from './admin-statistics-values';
import { SuggestionSubscriptionService } from '../suggestions/suggestion-subscription.service';
import { MaxMemberRestoreUnavailableError } from '../max/max-member-restore-capability';
import { attemptManualMemberUnban } from './manual-member-unban-attempt';
import {
  assertChannelMemberBanScope,
  describeManualBanResult,
  prepareManualBanFanoutTarget,
  resolveManualMemberBanMode,
} from './manual-member-ban-policy';
import {
  buildChannelSuggestionMediaMetadata,
  prepareChannelSuggestionMediaRows,
  prepareNormalizedChannelSuggestionImageRows,
} from './admin-channel-suggestion-image-storage';
import { uploadChannelSuggestionVideo } from './admin-channel-suggestion-video';
import {
  addAdminRequestSchema,
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  chatSettingsScreenResponseSchema,
  channelSettingsScreenResponseSchema,
  channelDialogResponseSchema,
  type ChannelDialogNotificationMode,
  type ChannelDialogNotificationScope,
  type ChannelDialogNotificationSettings,
  channelDialogTypeSchema,
  createChannelDialogMessageRequestSchema,
  createChannelDialogMessageResponseSchema,
  deleteChannelDialogMessageRequestSchema,
  deleteChannelDialogMessageResponseSchema,
  dateRangeQuerySchema,
  manualModerationActionRequestSchema,
  manualModerationActionResultSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  type ChannelDialogMessage,
  type ChannelDialogAttachment,
  type ChannelDialogReactionGroup,
  type ChannelDialogReplyPreview,
  type ChannelDialogSuggestionReviewStatus,
  type ToggleChannelDialogReactionResponse,
  type ChatParticipantImmunityUpdateResult,
  type ChatParticipantsPage,
  type ChatUnavailableParticipantsCleanupResult,
  type ChannelDialogType,
  type ChannelSuggestionVideoInput,
  type ChannelStatsQuery,
  type ChannelStatsResponse,
  type ChannelOverview,
  type ApplySectionToAllResponse,
  type ApplySettingsTarget,
  type ApplySectionTargetPreviewResponse,
  type ManagedBroadcastDetails,
  type ManagedBroadcastCalendarResponse,
  type ManagedEntityFavoriteType,
  type MembershipActivityPage,
  type ManagedBroadcastSummary,
  type ManagedEntityBotCapability,
  type ChannelSettings,
  type ChatSettingsScreenResponse,
  type ChatRules,
  type ChatSettings,
  type ChannelSettingsScreenResponse,
  type DomainAllowlistEntry,
  type LogsDashboardRange,
  type LogsDashboardResponse,
  type ManagedEntityType,
  type ManualModerationActionResult,
  type ModerationFeedPage,
  type ModerationEvent,
  type PublishChatRulesResult,
  type BroadcastTextFormat,
  type BroadcastLinkButton,
  type ManagedEntityAssignedBot,
  type ManagedEntitiesListResponse,
  type ManagedEntitiesResponseDiff,
  type ManagedEntitiesResponseSnapshot,
  type ManagedEntitiesRefreshState,
  type ManualModerationActionRequest,
  type SendBroadcastResult,
  type SendBroadcastTestResult,
  type ChatSummary,
  type ManagedEntityHeader,
  type ResolveRequiredSubscriptionChannelResponse,
  MAX_CHANNEL_DIALOG_ATTACHMENTS,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
  toggleChannelDialogReactionResponseSchema,
  updateChannelDialogNotificationsRequestSchema,
  updateChannelDialogNotificationsResponseSchema,
  updateChannelDialogMessageRequestSchema,
  updateChannelDialogMessageResponseSchema,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ChannelSuggestionAdminDeliveryStatus as PrismaChannelSuggestionAdminDeliveryStatus,
  ChatBotMembershipStatus,
  ChatEntityType,
  DialogNotificationMode as PrismaDialogNotificationMode,
  DialogNotificationScope as PrismaDialogNotificationScope,
  EventType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  ManualModerationFanoutLedgerStatus as PrismaManualModerationFanoutLedgerStatus,
  Operator,
  Prisma,
  PrismaClient,
  SanctionAction,
  createPrismaClient,
  type PrismaPoolConfig,
} from '../prisma/prisma-client';
import { ConfigService } from '@nestjs/config';
import { ReportViewService } from '../moderation/reports/report-view.service';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import {
  ChatContextCacheService,
  type ManagedEntitiesPublishedSnapshot,
} from '../chat-context/chat-context-cache.service';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { normalizeMaxUserDisplayName } from '../common/max-user-display-name.util';
import { raceWithTimeout } from '../common/promise-timeout.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
  wasMaxMemberMutationConfirmed,
  wasMaxMemberMutationAttempted,
  type MaxAttachmentPayload,
  type MaxBotChat,
  type MaxChatAdminMember,
  type MaxChatMemberAccess,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { confirmEraserSourceHolds } from '../message-retention/eraser-source-hold-barrier';
import { MaxBotExecutionPlannerService } from '../max/max-bot-execution-planner.service';
import { hasConfirmedDeleteMessageAccess } from '../max/max-delete-message-access.util';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import { MaxRoutedPublicationService } from '../max/max-routed-publication.service';
import { ManagedEntityCandidateSyncService } from './managed-entity-candidate-sync.service';
import {
  assertAdminSettingsBotCapabilities,
  refreshAdminSettingsBotCapabilitySnapshots as refreshBots,
} from './admin-settings-bot-capability.service';
import type { ChatSettingsBotCapabilityRequirement } from './chat-settings-bot-capability';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { escapeHtml, escapeHtmlAttribute } from '../common/max-text-markup.util';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { buildDuplicateUserPattern } from '../moderation/duplicate-state';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { buildModerationEscalationCounterPattern } from '../moderation/moderation-escalation-state.util';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import {
  ACTIVE_MUTE_CACHE_SLACK_SEC,
  ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
  PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC,
  buildActiveMuteStateKey,
  type CachedActiveMuteState,
} from '../moderation/moderation-state.util';
import {
  ModerationSanctionStateChangedError,
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockService,
  ModerationSanctionStateLockUnavailableError,
  type ModerationSanctionStateLeaseGuard,
} from '../moderation/moderation-sanction-state-lock.service';
import {
  ModerationSanctionStateFenceService,
  SANCTION_STATE_FENCE_RULE_CODE,
  type ModerationSanctionStateFence,
  type ModerationSanctionStateIntendedAction,
} from '../moderation/moderation-sanction-state-fence.service';
import {
  formatManualModerationUserLabel,
  sendManualBanChatNotice,
} from './manual-moderation-notice.util';
import {
  DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC,
  buildDeveloperForcedGlobalSpammerCacheKey,
} from '../moderation/developer-forced-global-spammer-cache';
import { RedisCounterService } from '../moderation/redis-counter.service';
import {
  SystemModeService,
  isSystemModeRecoveryWindow,
  type SystemModeSnapshot,
} from '../system/system-mode.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  resolveAdminManagedEntitiesRefreshJitterMs,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';
import { ADMIN_MANUAL_FANOUT_QUEUE, type AdminManualFanoutJob } from './admin-manual-fanout.queue';
import { AdminManualMessageCleanupService } from './admin-manual-message-cleanup.service';
import { ADMIN_SUPER_BAN_QUEUE, type AdminSuperBanJob } from './admin-super-ban.queue';
import {
  ADMIN_SUGGESTION_DELIVERY_QUEUE,
  type AdminSuggestionDeliveryJob,
} from './admin-suggestion-delivery.queue';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import { toggleDialogReactionValue } from './admin-channel-dialog-reaction';
import { getChannelSuggestionRedirectValue } from './admin-channel-dialog-redirect';
import {
  buildStoredLinkButtonState as buildStoredLinkButtonStateValue,
  decodeRulesImageBase64 as decodeRulesImageBase64Value,
  extractMaxApiErrorMessage as extractMaxApiErrorMessageValue,
  isMaxMessageMissingError as isMaxMessageMissingErrorValue,
  normalizeStoredLinkButtons as normalizeStoredLinkButtonsValue,
  publishChatRules,
  resetPublishedChatRules,
  resolveRulesImageFileName as resolveRulesImageFileNameValue,
  saveChatRulesDraft,
} from './admin-chat-rules';
import { AdminChatRulesTextRuntime } from './admin-chat-rules-text-runtime';
import { createAdminChatRulesTextRuntimeContext } from './admin-chat-rules-text-runtime-context';
import { AdminChannelDialogMappingRuntime } from './admin-channel-dialog-mapping-runtime';
import { createAdminChannelDialogMappingRuntimeContext } from './admin-channel-dialog-mapping-runtime-context';
import { AdminChannelSuggestionImageRuntime } from './admin-channel-suggestion-image-runtime';
import { createAdminChannelSuggestionImageRuntimeContext } from './admin-channel-suggestion-image-runtime-context';
import {
  hasChannelSuggestionBotScopedMediaToken,
  type ChannelSuggestionPublicationBotAssignment,
} from './admin-channel-suggestion-media-route';
import {
  buildChannelSuggestionDeliverySnapshot,
  createChannelSuggestionDeliveryRouteError,
  mergeChannelSuggestionPrivateDeliveryRoutes,
  resolveChannelSuggestionPrivateDeliveryRoutePlan,
  selectRetryableLogicalDeliveryRows,
  type ChannelSuggestionPrivateDeliveryRoute,
} from './admin-channel-suggestion-delivery-route';
import {
  findRecentRecoverableChannelSuggestionAuditLogIds,
  findRetryableChannelSuggestionAuditLogIds,
  isTerminalPrivateDialogDeliveryRow,
  recoverChannelSuggestionAdminDeliveriesAfterBotStarted,
} from './admin-channel-suggestion-delivery-recovery';
import {
  CHANNEL_SUGGESTION_ADMIN_DELIVERY_DEFAULT_BOT_KEY,
  CHANNEL_SUGGESTION_DELIVERY_DISPATCH_STARTED_CODE,
  CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE,
  assertChannelSuggestionEditorBeforeDispatch,
  finalizeConfirmedChannelSuggestionDelivery,
  persistChannelSuggestionPreclaimFailure,
  reconcileAuthoritativeChannelSuggestionEditorRoster,
  reconcileStaleChannelSuggestionDeliveryClaims,
} from './admin-channel-suggestion-delivery-ledger';
import {
  AdminChannelSuggestionPublicationRuntime,
  createAdminChannelSuggestionPublicationRuntimeContext,
} from './admin-channel-suggestion-publication-runtime';
import {
  resolveChannelSuggestionActorDisplayName as resolveChannelSuggestionActorDisplayNameValue,
  resolveChannelSuggestionAuthorAttribution as resolveChannelSuggestionAuthorAttributionValue,
} from './admin-channel-suggestion-author';
import { buildChannelSuggestionAdminMessagePayload as buildChannelSuggestionAdminMessagePayloadValue } from './admin-channel-suggestion-presentation';
import { AdminChannelStatsRuntime } from './admin-channel-stats-runtime';
import { StatisticsExchangeAudienceService } from '../integrations/marketplace/statistics-exchange-audience.service';
import { createAdminChannelStatsRuntimeContext } from './admin-channel-stats-runtime-context';
import { AdminDomainAllowlistRuntime } from './admin-domain-allowlist-runtime';
import { createAdminDomainAllowlistRuntimeContext } from './admin-domain-allowlist-runtime-context';
import { AdminLogsDashboardRuntime } from './admin-logs-dashboard-runtime';
import { createAdminLogsDashboardRuntimeContext } from './admin-logs-dashboard-runtime-context';
import {
  AdminManualModerationRuntime,
  ManualModerationOutcomeUncertainError,
} from './admin-manual-moderation-runtime';
import { createAdminManualModerationRuntimeContext } from './admin-manual-moderation-runtime-context';
import {
  AdminManagedEntityAccessRuntime,
  type PrunePersistedChatAccessOptions,
} from './admin-managed-entity-access-runtime';
import {
  createAdminManagedEntityAccessRuntimeContext,
  type MarkManagedEntityAccessEdgesDeniedForUserParams,
} from './admin-managed-entity-access-runtime-context';
import { AdminManagedEntitiesRuntime } from './admin-managed-entities-runtime';
import { listCanonicalFavoriteChatIdsForSettingsTarget } from './managed-entity-favorite-settings-targets';
import { createAdminManagedEntitiesRuntimeContext } from './admin-managed-entities-runtime-context';
import { AdminParticipantsRuntime } from './admin-participants-runtime';
import { createAdminParticipantsRuntimeContext } from './admin-participants-runtime-context';
import { AdminRequiredSubscriptionRuntime } from './admin-required-subscription-runtime';
import { createAdminRequiredSubscriptionRuntimeContext } from './admin-required-subscription-runtime-context';
import { AdminSuggestionDeliveryRuntime } from './admin-suggestion-delivery-runtime';
import { createAdminSuggestionDeliveryRuntimeContext } from './admin-suggestion-delivery-runtime-context';
import {
  publishChannelEngagementMessage as publishChannelEngagementMessageValue,
  type BuildChannelEngagementDialogArtifactsParams,
  type ChannelEngagementDialogArtifacts,
} from './admin-channel-engagement';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import { parsePublisherTemporalSelectionRollout } from './publisher-publication-temporal-enrollment';
import { throwLegacyPublicationWritesDisabled } from './legacy-publication-write-freeze';
import {
  applySettingsSectionToAllChats as applySettingsSectionToAllChatsValue,
  applySettingsToAllChats as applySettingsToAllChatsValue,
  previewApplySettingsSectionTarget as previewApplySettingsSectionTargetValue,
} from './admin-settings-apply';
import {
  readPublicChannelSettings as readPublicChannelSettingsValue,
  readChannelSettings as readChannelSettingsValue,
  saveChannelSettings as saveChannelSettingsValue,
} from './admin-channel-settings';
import {
  isPublisherChatAutoAttachPayload,
  resolveDialogAuditAction,
  resolveDialogCommentsTargetMessageId,
} from './admin-dialog-profile-helpers';
import {
  isRequiredSubscriptionCurrentlyActive,
  normalizeChatSettings,
  readPublicChatCommentSettings as readPublicChatCommentSettingsValue,
  readChatSettings as readChatSettingsValue,
  readChatSettingsSnapshot as readChatSettingsSnapshotValue,
  saveChatSettings as saveChatSettingsValue,
  type PublicChatCommentSettings,
  type ResolvedBotAssignmentData,
} from './admin-chat-settings';
import {
  buildProfileMentionHandoffUrl,
  buildUserProfileUrl,
  normalizeLegacyProfileButtonUrl,
  normalizeMaxProfileUrl,
} from './admin-profile-links';
import {
  buildChannelOverview,
  buildResolvedUserProfileCacheKey,
  extractMaxErrorCode,
  extractMaxErrorMessage,
  extractMaxErrorStatus,
  fromPrismaEntityType,
  ignorePrismaUniqueConflict,
  isBotAdminLookupDeniedError,
  isFallbackTitle,
  isMaxApiThrottleError,
  isMaxApiTimeoutError,
  isPrivateDialogChatUnavailableError,
  isPrismaKnownError,
  isUnsupportedManagedChat,
  mapWithConcurrencyLimit,
  normalizeAppBaseUrl,
  normalizeBotContactId,
  normalizeOwnBotUserId,
  resolvePresentableManagedEntityTitle,
  toPrismaEntityType,
} from './admin-legacy-utils';
import {
  buildManagedBroadcastButtonState as buildManagedBroadcastButtonStateValue,
  buildManagedBroadcastLinkButtonRows,
  normalizeManagedBroadcastButtons as normalizeManagedBroadcastButtonsValue,
  type ManagedBroadcastLegacyButtonState,
} from './admin-managed-broadcast-buttons';
import {
  createAdminManagedBroadcastRuntimeContext,
  type ManagedBroadcastButtonContextOptions,
  type ManagedBroadcastButtonContextResult,
} from './admin-managed-broadcast-runtime-context';
import { resolveManagedBroadcastButtonContext } from './admin-managed-broadcast-button-context';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherChatCommentQueueService } from '../publisher/publisher-chat-comment.queue';
import { PublisherSuggestionPublicationQueueService } from './publisher-suggestion-publication-queue.service';
import { PublisherDialogContextService } from './publisher-dialog-context.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { PublisherCommentNotificationService } from '../publisher/publisher-comment-notification.service';
import {
  buildPublisherSuggestionAdminReviewCallbackPayload,
  buildPublisherSuggestionAdminSyncMarker,
  PublisherSuggestionAdminQueueService,
} from '../publisher/publisher-suggestion-admin.queue';
import { PublisherDialogProfileRuntime } from './publisher-dialog-profile-runtime';
import { createCommentDialogAudit } from './comment-dialog-write';
import {
  countPublisherChatComments,
  toggleDialogCommentReactionForProfile,
  updateDialogCommentForProfile,
} from './publisher-chat-comment-store';
import { AdminDialogAdminAccessRuntime } from './admin-dialog-admin-access-runtime';
import {
  createCommentsButtonPosition,
  PublisherCommentKeyboardRouting,
} from './publisher-comment-keyboard-routing';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import {
  buildChannelCommentCountKeyboard,
  prepareStoredChannelCommentsKeyboard,
  refreshCommentsButtonCount,
} from './admin-channel-comment-keyboard';
import {
  decodeBroadcastImageBase64 as decodeBroadcastImageBase64Value,
  isManagedBroadcastSlotConflictError as isManagedBroadcastSlotConflictErrorValue,
  resolveBroadcastImageFileName as resolveBroadcastImageFileNameValue,
  resolveManagedBroadcastAttachmentRetryCount,
  resolveManagedBroadcastSendRetryDelayMs as resolveManagedBroadcastSendRetryDelayMsValue,
  type ManagedBroadcastRetriableAttachmentOptions,
} from './admin-managed-broadcast-media';
import {
  buildManagedEntitiesPublishedSnapshotDiff,
  buildManagedEntitiesPublishedSnapshotHash,
  cloneManagedEntitySummarySnapshotValue,
} from './admin-managed-entities-snapshot-codec';

import {
  DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS,
  ADMIN_ACCESS_VALIDATION_ROSTER_SYNC_THROTTLE_MS,
  BROADCAST_THROTTLE_RETRY_DELAYS_MS,
  CHANNEL_SUGGESTION_ADMIN_LOOKUP_TIMEOUT_MS,
  CHANNEL_SUGGESTION_DELIVERY_RECOVERY_BATCH_SIZE,
  CHANNEL_SUGGESTION_DELIVERY_JOB_TIMEOUT_MS,
  CHANNEL_SUGGESTION_DELIVERY_RECOVERY_STALE_MS,
  CHANNEL_SUGGESTION_SEND_TIMEOUT_MS,
  CHANNEL_SUGGESTION_UPLOAD_TIMEOUT_MS,
  RESOLVED_USER_PROFILE_CACHE_TTL_MS,
  ONE_HOUR_MS,
  TWENTY_FOUR_HOURS_MS,
  LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
  MANAGED_ENTITIES_DELTA_ADMIN_CHECK_SPACING_MS,
  MANAGED_ENTITIES_FULL_SCAN_ADMIN_CHECK_SPACING_MS,
  MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE,
  MANAGED_ENTITIES_FOREGROUND_CANDIDATE_CHECK_LIMIT,
  MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT,
  MANAGED_ENTITIES_REFRESH_SCAN_WINDOW_SIZE,
  MANAGED_ENTITIES_BACKGROUND_CATALOG_SYNC_WINDOW_SIZE,
  MANAGED_ENTITIES_LOCAL_REFRESH_SCAN_WINDOW_SIZE,
  MANAGED_ENTITIES_ALLOWLIST_RESPONSE_BUDGET_MS,
  MANAGED_ENTITIES_ACCESS_EDGE_RESPONSE_BUDGET_MS,
  MANAGED_ENTITIES_ACCESS_EDGE_RESPONSE_LIMIT,
  MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_REVALIDATION_LIMIT,
  MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_ADMIN_TIMEOUT_MS,
  MANAGED_ENTITIES_LIGHTWEIGHT_RECENT_BOOTSTRAP_RESPONSE_BUDGET_MS,
  MANAGED_ENTITIES_RESPONSE_WARMUP_BUDGET_MS,
  MANAGED_ENTITIES_LOCAL_DISCOVERY_ADMIN_TIMEOUT_MS,
  MANAGED_ENTITIES_REMOTE_DELTA_ADMIN_TIMEOUT_MS,
  MANAGED_ENTITIES_REMOTE_FULL_SCAN_ADMIN_TIMEOUT_MS,
  MANAGED_ENTITIES_REMOTE_DELTA_SNAPSHOT_TIMEOUT_MS,
  MANAGED_ENTITIES_REMOTE_FULL_SCAN_SNAPSHOT_TIMEOUT_MS,
  MANAGED_ENTITIES_PRIORITY_ALLOWLIST_WARMUP_LIMIT,
  MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
  MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC,
  MANAGED_ENTITIES_REFRESH_CURSOR_DONE_TTL_SEC,
  MANAGED_ENTITIES_REFRESH_SNAPSHOT_TTL_SEC,
  MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC,
  MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
  MANAGED_ENTITIES_REFRESH_SUCCESS_COOLDOWN_MS,
  MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS,
  MANAGED_ENTITIES_REFRESH_BACKOFF_MS,
  MANAGED_ENTITIES_REFRESH_FRESHNESS_WINDOW_MS,
  MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS,
  MANAGED_ENTITIES_REFRESH_DEGRADE_PAUSE_RETRY_MS,
  MANAGED_ENTITIES_REFRESH_QUEUE_LAG_SLOW_PATH_MAX_SEC,
  MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS,
  MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_COOLDOWN_MS,
  MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_CONCURRENCY,
  MANAGED_BOT_CHAT_CATALOG_WRITE_CONCURRENCY,
  MANAGED_BOT_CHAT_CATALOG_FALLBACK_LIMIT,
  MANAGED_BOT_CHAT_CATALOG_MARK_MISSING_MAX_SEEN,
  MANAGED_ENTITIES_MASS_ACTION_FULL_SCAN_MAX_PASSES,
  ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
  ADMIN_ACTION_HEALTH_LANE,
  DEFAULT_SUPER_BAN_DEVELOPER_USER_IDS,
  APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_CONCURRENCY,
  APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_SPACING_MS,
  CHANNEL_DIALOG_MESSAGES_LIMIT,
  COMMENT_NOTIFICATION_DELIVERY_CONCURRENCY,
  COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH,
  CHANNEL_DIALOG_ACTION_COMMENT,
  CHANNEL_DIALOG_ACTION_SUGGEST,
  PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
  DEFAULT_DIALOG_NOTIFICATION_SETTINGS,
  CHANNEL_DIALOG_ACTION_PUBLISH,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
  CHAT_DIALOG_ACTION_AUTO_ATTACH,
  PRIVATE_CONTROL_CALLBACK_PREFIX,
  DEFAULT_CHANNEL_SETTINGS,
  MANAGED_ENTITY_FAVORITE_TYPE_ORDER,
  CONTRACT_FAVORITE_TYPE_BY_PRISMA,
  CHANNEL_COMMENT_DUPLICATE_WINDOW_MS,
  CHANNEL_COMMENT_MAX_CONSECUTIVE,
  CHANNEL_COMMENT_LINK_PATTERN,
  RECENT_BOT_ADDED_BOOTSTRAP_LIMIT,
  RECENT_BOT_ADDED_USER_SCOPED_WEBHOOK_SCAN_LIMIT,
  RECENT_BOT_ADDED_WEBHOOK_SCAN_LIMIT,
  RECENT_BOT_ADDED_BOOTSTRAP_MAX_ELAPSED_MS,
  RECENT_BOT_ADDED_BOOTSTRAP_MAX_ADMIN_CHECKS,
  RECENT_BOT_ADDED_BOOTSTRAP_ADMIN_TIMEOUT_MS,
  RECENT_BOT_ADDED_BOOTSTRAP_HEADER_RESPONSE_BUDGET_MS,
  RECENT_BOT_ADDED_BOOTSTRAP_HEADER_TIMEOUT_MS,
  RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS,
  SETTINGS_SCREEN_ADMIN_CHECK_TIMEOUT_MS,
  MANAGED_ENTITIES_LOCAL_CANDIDATE_LIMIT,
  MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS,
  MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS,
  MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS,
  LOCAL_USER_DISPLAY_NAME_EVENT_TYPES,
  ManagedEntitiesRefreshThrottledError,
  readBooleanConfigFlag,
  readNonNegativeConfigInt,
  readPositiveConfigInt,
  sleep,
  sleepIfNeeded,
  type ApplySettingsToAllChatsResult,
  type ManagedEntityTypeFilter,
  type ManagedEntitiesListResult,
  type ManagedEntitiesRefreshPresentation,
  type ManagedEntitiesRefreshJobOutcome,
  type ManagedEntitiesPublishedSnapshotReadResult,
  type ManagedEntitiesPublishedDiffReadResult,
  type ChannelPublicationEngagementContext,
  type ManagedEntitiesListOptions,
  type ManagedEntitiesDiscoverySnapshot,
  type ManagedBotChatCatalogSnapshotRow,
  type ManagedBotChatMembershipSnapshotRow,
  type AssertChatAdminOptions,
  type AdminReadBypassOptions,
  type TimedPromiseCacheEntry,
  type AdminAccessResolution,
  type ManagedEntityAccessRoleValue,
  type ManagedEntityAccessStateValue,
  type ManagedEntityAccessEdgeClient,
  type AdminActionSource,
  type ManualBanFollowUpSource,
  type ManualModerationFanoutSource,
  type AdoptChatRulesFromMessageInput,
  type ManualMemberModerationAction,
  type ManualMemberManageMembersAction,
  type ManualModerationBotAction,
  type ManualBanExecutionMode,
  type ManualUnbanExecutionMode,
  type ManualModerationExecutionOptions,
  type ResolveManualModerationActionBotAssignmentOptions,
  type ResolvedUserProfile,
  type ResolveUserProfilesOptions,
  type ChannelSuggestionActor,
  type ChannelSuggestionAuthorAttribution,
  type ChannelSuggestionImageAsset,
  type ChannelDialogAttachmentAsset,
  type ChannelSuggestionTextMarkup,
  type ChannelSuggestionDeliveryInput,
  type ChannelDialogMessageSource,
  type DialogMessageEntityType,
  type CommentDialogNotificationKind,
  type ChannelSuggestionFromBotPayload,
  type ChannelSuggestionReviewAction,
  type ChannelSuggestionAdminDelivery,
  type ChannelSuggestionAdminDeliveryFailure,
} from './admin.service.support';
export type {
  AdminActionSource,
  ChannelPublicationEngagementContext,
} from './admin.service.support';

const CHANNEL_SUGGESTION_PRIVATE_ROUTE_LOOKUP_CONCURRENCY = 4;
const CHANNEL_SUGGESTION_TERMINAL_RECOVERY_LOOKBACK_MS = 7 * TWENTY_FOUR_HOURS_MS;
const MANUAL_MODERATION_FANOUT_LEDGER_STALE_MS = 10 * 60 * 1000;
const MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_REBUILD_MAX_ATTEMPTS = 3;

type ManualModerationFanoutLedgerOperation =
  | 'SOURCE_CLEANUP'
  | 'FANOUT_BAN_MEMBER'
  | 'FANOUT_MUTE_RECORD'
  | 'COMMAND_SOURCE_BAN'
  | 'COMMAND_SOURCE_MUTE'
  | 'COMMAND_NOTICE_OUTCOME'
  | 'COMMAND_NOTICE_SUCCESS'
  | 'COMMAND_NOTICE_FAILURE';

type ChannelSuggestionAdminDeliveryLedgerRow = {
  id: string;
  auditLogId: string;
  adminUserId: string;
  botKey: string;
  botId: string | null;
  privateChatId: string | null;
  status: PrismaChannelSuggestionAdminDeliveryStatus;
  attemptCount: number;
  remoteMessageId: string | null;
  lastError: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  terminal: boolean;
  sentAt: Date | null;
  lockedAt: Date | null;
  lockToken: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ChannelSuggestionDeliveryResult = {
  delivered: boolean;
  deliveredToUserId: string | null;
  deliveredToUserIds: string[];
  suggestionDelivery: import('@maxim/contracts').ChannelSuggestionDeliverySummary;
  deliveries: ChannelSuggestionAdminDelivery[];
  deliveryAttemptedAt: string;
  deliveryFailures: ChannelSuggestionAdminDeliveryFailure[];
};

type ChannelSuggestionAdminDeliveryScope = {
  auditAction: string;
  botKey: string;
  requiredBotId: string | null;
  publisherOwned: boolean;
};

type ManualModerationFanoutLedgerRow = {
  id: string;
  operationKey: string;
  jobId: string | null;
  rootIntentKey: string | null;
  sourceKind: string;
  operation: string;
  sourceChatId: string;
  targetChatId: string;
  targetUserId: string;
  actorUserId: string;
  logicalAction: string;
  executionMode: string | null;
  botId: string | null;
  status: PrismaManualModerationFanoutLedgerStatus;
  attemptCount: number;
  moderationEventId: string | null;
  auditLogId: string | null;
  remoteMessageId: string | null;
  lastError: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  metadata: Prisma.JsonValue | null;
  terminal: boolean;
  lockedAt: Date | null;
  lockToken: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ManualModerationFanoutLedgerClaim =
  | {
      claimed: true;
      operationKey: string;
      lockToken: string;
      row: ManualModerationFanoutLedgerRow;
    }
  | {
      claimed: false;
      operationKey: string;
      row: ManualModerationFanoutLedgerRow | null;
      reason: 'terminal' | 'fresh-lock' | 'ambiguous';
    };

type DialogNotificationPreferenceRow = {
  userId: string;
  mode: PrismaDialogNotificationMode;
  explicit?: boolean | null;
  targetKey?: string | null;
};

type DialogNotificationRecipientCandidate = {
  userId: string;
  mode: PrismaDialogNotificationMode;
  source: 'thread' | 'channel' | 'all_channels';
};

const DEVELOPER_SUPER_BAN_PRIVATE_DIALOG_ID_PREFIXES = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
] as const;

@Injectable()
export class AdminService implements OnModuleDestroy {
  private readonly logger = new Logger(AdminService.name);
  private readonly managedBroadcastRuntime = ((owner: AdminService) => {
    // FLAG: Resolve constructor-owned dependencies lazily and preserve their receivers.
    return new AdminManagedBroadcastRuntime(
      createAdminManagedBroadcastRuntimeContext({
        get publisherTemporalSelectionRollout() {
          return parsePublisherTemporalSelectionRollout(
            owner.configService.get('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT'),
          );
        },
        get prisma() {
          return owner.prisma;
        },
        get maxClient() {
          return owner.maxClient;
        },
        get logger() {
          return owner.logger;
        },
        get backgroundRuntimeGovernorService() {
          return owner.backgroundRuntimeGovernorService;
        },
        get managedEntityAccessLossService() {
          return owner.managedEntityAccessLossService;
        },
        get maxRoutedPublicationService() {
          return owner.maxRoutedPublicationService;
        },
        get channelPostSignatureService() {
          return owner.channelPostSignatureService;
        },
        get publisherRuntimeBoundaryService() {
          return owner.publisherRuntimeBoundaryService;
        },
        get publisherReadinessService() {
          return owner.publisherReadinessService;
        },
        get publisherDialogContextService() {
          return owner.publisherDialogContextService;
        },
        get publisherDispatchHealthService() {
          return owner.publisherDispatchHealthService;
        },
        resolveSystemModeSnapshot: () => owner.resolveSystemModeSnapshot(),
        resolveDeliveryBotAssignment: (chatId) => owner.resolveDeliveryBotAssignment(chatId),
        resolvePrivateDeliveryBotId: (botId) => owner.resolvePrivateDeliveryBotId(botId),
        resolvePrivateDialogChatId: (user, botId) => owner.resolvePrivateDialogChatId(user, botId),
        listChatsForMassBroadcast: (user, options) =>
          owner.listChatsForMassBroadcast(user, options),
        assertManagedEntityAdminAccess: (chatId, userId, entityType) =>
          owner.assertManagedEntityAdminAccess(chatId, userId, entityType),
        assertManagedEntityReadAccess: (chatId, userId, entityType, options) =>
          owner.assertManagedEntityReadAccess(chatId, userId, entityType, options),
        resolveBroadcastButtonContext: (chatId, entityType, options, botId) =>
          owner.resolveBroadcastButtonContext(chatId, entityType, options, botId),
      }),
    );
  })(this);
  private readonly publisherCommentKeyboardRouting: PublisherCommentKeyboardRouting;
  private readonly publisherDialogProfileRuntime: PublisherDialogProfileRuntime;
  private readonly dialogAdminAccessRuntime: AdminDialogAdminAccessRuntime;
  private readonly chatRulesTextRuntime = ((owner: AdminService) => {
    // FLAG: Resolve dependencies lazily; constructor-owned clients and secrets initialize later.
    return new AdminChatRulesTextRuntime(
      createAdminChatRulesTextRuntimeContext({
        get prisma() {
          return owner.prisma;
        },
        get chatContextCache() {
          return owner.chatContextCache;
        },
        get maxClient() {
          return owner.maxClient;
        },
        get logger() {
          return owner.logger;
        },
        get maxBotTokenValidationSecrets() {
          return owner.maxBotTokenValidationSecrets;
        },
        getSettings: (chatId, user) => owner.getSettings(chatId, user),
        getDomainAllowlistDetails: (chatId, user) => owner.getDomainAllowlistDetails(chatId, user),
        resolveRequiredSubscriptionChannelHeaders: (channelIds) =>
          owner.resolveRequiredSubscriptionChannelHeaders(channelIds),
        resolveUserDisplayNames: (chatId, userIds) =>
          owner.resolveUserDisplayNames(chatId, userIds),
        resolveChatSettingsReadBotAssignmentData: (chatId) =>
          owner.resolveChatSettingsReadBotAssignmentData(chatId),
      }),
    );
  })(this);
  private readonly channelDialogMappingRuntime = new AdminChannelDialogMappingRuntime(
    createAdminChannelDialogMappingRuntimeContext(channelDialogValues),
  );
  private readonly channelSuggestionImageRuntime = ((owner: AdminService) =>
    new AdminChannelSuggestionImageRuntime(
      createAdminChannelSuggestionImageRuntimeContext({
        get logger() {
          return owner.logger;
        },
        get prisma() {
          return owner.prisma;
        },
        normalizeChannelSuggestionImages: channelDialogValues.normalizeChannelSuggestionImages,
        readChannelSuggestionImageAssets: channelDialogValues.readChannelSuggestionImageAssets,
        readChannelSuggestionMediaType: channelDialogValues.readChannelSuggestionMediaType,
        readObjectPayloadOrNull: channelDialogValues.readObjectPayloadOrNull,
        readTrimmedString: channelDialogValues.readTrimmedString,
      }),
    ))(this);
  readonly channelSuggestionPublicationRuntime = ((owner: AdminService) => {
    // FLAG: Constructor-owned clients must remain lazy; authorization and send ordering stay in the runtime.
    return new AdminChannelSuggestionPublicationRuntime(
      createAdminChannelSuggestionPublicationRuntimeContext({
        get suggestionSubscriptions() {
          return owner.suggestionSubscriptions;
        },
        get logger() {
          return owner.logger;
        },
        get prisma() {
          return owner.prisma;
        },
        get maxClient() {
          return owner.maxClient;
        },
        get maxRoutedPublicationService() {
          return owner.maxRoutedPublicationService;
        },
        get channelSuggestionImageRuntime() {
          return owner.channelSuggestionImageRuntime;
        },
        get publisherReadinessService() {
          return owner.publisherReadinessService;
        },
        get publisherRuntimeBoundaryService() {
          return owner.publisherRuntimeBoundaryService;
        },
        get publisherDispatchHealthService() {
          return owner.publisherDispatchHealthService;
        },
        get publisherSuggestionPublicationQueue() {
          return owner.publisherSuggestionPublicationQueue;
        },
        get publisherDialogContextService() {
          return owner.publisherDialogContextService;
        },
        get channelPostSignatureService() {
          return owner.channelPostSignatureService;
        },
        assertChatAdmin: (chatId, userId, expectedType) =>
          owner.assertChatAdmin(chatId, userId, expectedType),
        ensureEntityType: (chatId, userId, expectedType) =>
          owner.ensureEntityType(chatId, userId, expectedType),
        resolveChannelSuggestionPublicationBotAssignment: (chatId) =>
          owner.resolveChannelSuggestionPublicationBotAssignment(chatId),
        resolveDeliveryBotAssignment: (chatId) => owner.resolveDeliveryBotAssignment(chatId),
        resolveChannelSuggestionAuthorAttribution: (chatId, actor, options) =>
          owner.resolveChannelSuggestionAuthorAttribution(chatId, actor, options),
        resolveChannelSuggestionAttachments: (suggestion, botId) =>
          owner.resolveChannelSuggestionAttachments(suggestion, botId),
        getPublicChannelSettings: (chatId) => owner.getPublicChannelSettings(chatId),
        buildChannelDialogButton: (chatId, type, threadId, text, botId, suggestionEntryMode) =>
          owner.buildChannelDialogButton(chatId, type, threadId, text, botId, suggestionEntryMode),
        syncChannelSuggestionAdminReviewMessages: (suggestionId, chatId, payload) =>
          owner.syncChannelSuggestionAdminReviewMessages(suggestionId, chatId, payload),
        readObjectPayload: channelDialogValues.readObjectPayload,
        readObjectPayloadOrNull: channelDialogValues.readObjectPayloadOrNull,
        readLowerString: channelDialogValues.readLowerString,
        readTrimmedString: channelDialogValues.readTrimmedString,
        readRawString: channelDialogValues.readRawString,
        readChannelSuggestionMediaType: channelDialogValues.readChannelSuggestionMediaType,
        readChannelSuggestionTextMarkup: channelDialogValues.readChannelSuggestionTextMarkup,
        readStoredChannelSuggestionActor: channelDialogValues.readStoredChannelSuggestionActor,
        normalizeBroadcastTextFormat: channelDialogValues.normalizeBroadcastTextFormat,
        sleep: (ms) => owner.sleep(ms),
      }),
    );
  })(this);

  private readonly channelStatsRuntime = ((owner: AdminService) =>
    new AdminChannelStatsRuntime(
      createAdminChannelStatsRuntimeContext({
        get prisma() {
          return owner.prisma;
        },
        get maxClient() {
          return owner.maxClient;
        },
        get chatContextCache() {
          return owner.chatContextCache;
        },
        get logger() {
          return owner.logger;
        },
        get channelStatsCollector() {
          return owner.channelStatsCollector;
        },
        get statisticsExchange() {
          return owner.statisticsExchange;
        },
        getMembershipActivityFeedPage: (chatId, from, to, query, entityType, profileOptions) =>
          owner.logsDashboardRuntime.getMembershipActivityFeedPage(
            chatId,
            from,
            to,
            query,
            entityType,
            profileOptions,
          ),
        buildEmptyMembershipActivityPage: () =>
          owner.logsDashboardRuntime.buildEmptyMembershipActivityPage(),
        resolveAssistBotAssignment: (chatId, capability) =>
          owner.resolveAssistBotAssignment(chatId, capability),
        assertReadOnlyChatAdmin: (chatId, userId, entityType, options) =>
          owner.assertReadOnlyChatAdmin(chatId, userId, entityType, options),
        ensureEntityType: (chatId, userId, expectedEntityType) =>
          owner.ensureEntityType(chatId, userId, expectedEntityType),
      }),
    ))(this);
  private readonly domainAllowlistRuntime = ((owner: AdminService) => {
    // FLAG: Resolve dependencies lazily; constructor-owned clients and secrets initialize later.
    return new AdminDomainAllowlistRuntime(
      createAdminDomainAllowlistRuntimeContext({
        get prisma() {
          return owner.prisma;
        },
        get chatContextCache() {
          return owner.chatContextCache;
        },
        assertChatAdmin: (chatId, userId, entityType) =>
          owner.assertChatAdmin(chatId, userId, entityType),
      }),
    );
  })(this);

  private readonly logsDashboardRuntime = ((owner: AdminService) =>
    new AdminLogsDashboardRuntime(
      createAdminLogsDashboardRuntimeContext({
        get prisma() {
          return owner.prisma;
        },
        get logger() {
          return owner.logger;
        },
        get chatContextCache() {
          return owner.chatContextCache;
        },
        assertChatAdmin: (chatId, userId, entityType, options) =>
          owner.assertChatAdmin(chatId, userId, entityType, options),
        assertReadOnlyChatAdmin: (chatId, userId, entityType, options) =>
          owner.assertReadOnlyChatAdmin(chatId, userId, entityType, options),
        buildProfileMentionHandoffUrl: (chatId, entityType, userId, displayName) =>
          owner.buildProfileMentionHandoffUrl(chatId, entityType, userId, displayName),
        ensureEntityType: (chatId, userId, expectedEntityType) =>
          owner.ensureEntityType(chatId, userId, expectedEntityType),
        resolveUserProfiles: (chatId, entityType, userIds, options) =>
          owner.resolveUserProfiles(chatId, entityType, userIds, options),
      }),
    ))(this);
  private readonly manualModerationRuntime = ((owner: AdminService) =>
    new AdminManualModerationRuntime(
      createAdminManualModerationRuntimeContext({
        get logger(): Logger {
          return owner.logger;
        },
        get adminSuperBanQueue(): Queue<AdminSuperBanJob> | undefined {
          return owner.adminSuperBanQueue;
        },
        get adminManualFanoutQueue(): Queue<AdminManualFanoutJob> | undefined {
          return owner.adminManualFanoutQueue;
        },
        enqueueManualModerationFanout: (job) => owner.enqueueManualModerationFanout(job),
        isKnownRuntimeBotUserId: (userId) => owner.isKnownRuntimeBotUserId(userId),
        isSuperBanDeveloperUserId: (userId) => owner.isSuperBanDeveloperUserId(userId),
        processDeveloperSuperBanJob: (job) => owner.processDeveloperSuperBanJob(job),
        processManualSystemBan: (chatId, targetUserId, actor, source, options) =>
          owner.applyManualSystemBan(chatId, targetUserId, actor, source, options),
        processManualModerationAction: (chatId, targetUserId, actor, body, source, options) =>
          owner.applyManualModerationAction(chatId, targetUserId, actor, body, source, options),
        resolveManualCommandFanoutChats: (actor, sourceChatId) =>
          owner.resolveManualCommandFanoutChats(actor, sourceChatId),
        runManualSourceCleanupWithLedger: (params) =>
          owner.runManualSourceCleanupWithLedger(params),
        applyManualMuteFanout: (params) => owner.applyManualMuteFanout(params),
        applyManualSystemBanFanout: (params) => owner.applyManualSystemBanFanout(params),
        resolveManualGroupCommandCleanupBotId: (chatId, preferredBotId) =>
          owner.resolveManualGroupCommandCleanupBotId(chatId, preferredBotId),
        resolveManualModerationTargetDisplayName: (chatId, targetUserId, options) =>
          owner.resolveManualModerationTargetDisplayName(chatId, targetUserId, options),
        deleteManualGroupCommandTargetMessage: (job, options) =>
          owner.deleteManualGroupCommandTargetMessage(job, options),
        deleteManualGroupCommandMessage: (chatId, messageId, options) =>
          owner.deleteManualGroupCommandMessage(chatId, messageId, options),
        readManualModerationFanoutIntentRow: (params) =>
          owner.readManualModerationFanoutIntentRow(params),

        resolveManualModerationActionBotAssignment: ({ chatId, action, options }) =>
          owner.resolveManualModerationActionBotAssignment(chatId, action, options),
        assertBotCanDeleteMessages: (chatId, botId) =>
          owner.assertBotCanDeleteMessages(chatId, botId),
        deleteRecentTrackedMessagesForManualAction: (chatId, targetUserId, options) =>
          owner.deleteRecentTrackedMessagesForManualAction(chatId, targetUserId, options),
        runManualBanSourceCleanup: (chatId, targetUserId, actorUserId, options) =>
          owner.runManualBanSourceCleanup(chatId, targetUserId, actorUserId, options),
        runManualBanFanoutInlineSummary: (params) => owner.runManualBanFanoutInlineSummary(params),

        normalizeManualModerationBotId: (value) => owner.normalizeManualModerationBotId(value),
        canResolveCurrentChatMemberAccess: () =>
          typeof owner.maxClient.getCurrentChatMemberAccess === 'function',
        resolveDeliveryBotAssignment: (chatId) => owner.resolveDeliveryBotAssignment(chatId),

        claimManualModerationFanoutLedgerEntry: (params) =>
          owner.claimManualModerationFanoutLedgerEntry(params),
        completeManualModerationFanoutLedgerEntry: (params) =>
          owner.completeManualModerationFanoutLedgerEntry(params),
        markManualModerationFanoutLedgerFailed: (params) =>
          owner.markManualModerationFanoutLedgerFailed(params),
        findSettledManualGroupCommandOutcomeRows: ({ jobId, chatId, targetUserId }) =>
          owner.prisma.manualModerationFanoutLedgerEntry.findMany({
            where: {
              jobId,
              operation: {
                in: ['COMMAND_NOTICE_OUTCOME', 'COMMAND_NOTICE_SUCCESS', 'COMMAND_NOTICE_FAILURE'],
              },
              targetChatId: chatId,
              targetUserId,
              status: { in: ['SUCCEEDED', 'AMBIGUOUS'] },
            },
            select: { operation: true },
            take: 3,
          }),
        assertManualGroupCommandSuccessNoticeAuthority: (input) =>
          assertManualGroupCommandSuccessNoticeAuthority(owner.prisma, owner.maxClient, input),
        sendMessage: (chatId, text, options, dispatchOptions) =>
          owner.maxClient.sendMessage(chatId, text, options, dispatchOptions),
      }),
    ))(this);
  private readonly managedEntitiesSnapshotRuntime = new AdminManagedEntitiesSnapshotRuntime({
    filterToRuntimeScope: (chats) => this.filterManagedEntitiesToRuntimeScope(chats),
    loadAllowlist: (userId, entityType) => this.listChatsFromAllowlistUncached(userId, entityType),
  });
  private readonly managedEntityAccessRuntime = ((owner: AdminService) =>
    new AdminManagedEntityAccessRuntime(
      createAdminManagedEntityAccessRuntimeContext({
        get prisma(): PrismaService {
          return owner.prisma;
        },
        get chatContextCache(): ChatContextCacheService {
          return owner.chatContextCache;
        },
        get logger(): Logger {
          return owner.logger;
        },
        get managedEntitiesRuntimeBotIds(): ReadonlySet<string> {
          return owner.managedEntitiesRuntimeBotIds;
        },
        forgetManagedEntitiesLastSuccessChat: (userId, chatId) =>
          owner.managedEntitiesSnapshotRuntime.forgetManagedEntitiesLastSuccessChat(userId, chatId),
        invalidateManagedEntitiesAllowlistCache: (userId) =>
          owner.managedEntitiesSnapshotRuntime.invalidateManagedEntitiesAllowlistCache(userId),
        get accessEdges() {
          return owner.getManagedEntityAccessEdgeClient();
        },
        normalizeManagedEntityAccessBotId: (botId) =>
          owner.normalizeManagedEntityAccessBotId(botId),
      }),
    ))(this);
  private readonly managedEntitiesRuntime = ((owner: AdminService) =>
    new AdminManagedEntitiesRuntime(
      createAdminManagedEntitiesRuntimeContext({
        get prisma(): PrismaService {
          return owner.prisma;
        },
        get chatContextCache(): ChatContextCacheService {
          return owner.chatContextCache;
        },
        get maxClient(): MaxClientService {
          return owner.maxClient;
        },
        get logger(): Logger {
          return owner.logger;
        },
        get maxBotRegistry(): MaxBotRegistryService | undefined {
          return owner.maxBotRegistry;
        },
        assertChatAdmin: (chatId, userId, entityType, options) =>
          owner.assertChatAdmin(chatId, userId, entityType, options),
        assertReadOnlyChatAdmin: (chatId, userId, entityType, options) =>
          owner.assertReadOnlyChatAdmin(chatId, userId, entityType, options),
        attachManagedEntityFavoriteTypes: (userId, items) =>
          owner.attachManagedEntityFavoriteTypes(userId, items),
        attachManagedEntityFavoriteTypesToDiff: (userId, diff) =>
          owner.attachManagedEntityFavoriteTypesToDiff(userId, diff),
        collectManagedEntitiesForMassAction: (user, entityType, options) =>
          owner.collectManagedEntitiesForMassAction(user, entityType, options),
        ensureEntityType: (chatId, userId, expectedEntityType) =>
          owner.ensureEntityType(chatId, userId, expectedEntityType),
        isManagedEntityRuntimeBotId: (botId) => owner.isManagedEntityRuntimeBotId(botId),
        listManagedEntitiesDetailed: (user, entityType, options) =>
          owner.listManagedEntitiesDetailed(user, entityType, options),

        resolveBackgroundReadBotAssignment: (chatId) =>
          owner.resolveBackgroundReadBotAssignment(chatId),
        runManagedEntitiesBoundedRefreshJob: (user, entityType, options) =>
          owner.runManagedEntitiesBoundedRefreshJob(user, entityType, options),
        runManagedEntitiesRemoteFullRefresh: (user, entityType, options) =>
          owner.runManagedEntitiesRemoteFullRefresh(user, entityType, options),
      }),
    ))(this);

  private readonly participantsRuntime = ((owner: AdminService) =>
    new AdminParticipantsRuntime(
      createAdminParticipantsRuntimeContext({
        get prisma() {
          return owner.prisma;
        },
        get maxClient() {
          return owner.maxClient;
        },
        get logger() {
          return owner.logger;
        },
        get managedEntityAccessLossService() {
          return owner.managedEntityAccessLossService;
        },
        assertReadOnlyChatAdmin: (chatId, userId, entityType, options) =>
          owner.assertReadOnlyChatAdmin(chatId, userId, entityType, options),
        buildProfileMentionHandoffUrl: (chatId, entityType, userId, displayName, botId) =>
          owner.buildProfileMentionHandoffUrl(chatId, entityType, userId, displayName, botId),
        ensureEntityType: (chatId, userId, expectedEntityType) =>
          owner.ensureEntityType(chatId, userId, expectedEntityType),
        getManagedEntityHeader: (chatId, user, entityType, options) =>
          owner.getManagedEntityHeader(chatId, user, entityType, options),
        prepareManualModerationTarget: (chatId, targetUserIdRaw, user, options) =>
          owner.prepareManualModerationTarget(chatId, targetUserIdRaw, user, options),
        resolveBackgroundReadBotAssignment: (chatId) =>
          owner.resolveBackgroundReadBotAssignment(chatId),
        resolveParticipantCleanupBotAssignment: (chatId) =>
          owner.resolveParticipantCleanupBotAssignment(chatId),
        isKnownRuntimeBotUserId: (userId) => owner.isKnownRuntimeBotUserId(userId),
      }),
    ))(this);
  private readonly requiredSubscriptionRuntime = ((owner: AdminService) =>
    new AdminRequiredSubscriptionRuntime(
      createAdminRequiredSubscriptionRuntimeContext({
        get prisma(): PrismaService {
          return owner.prisma;
        },
        get maxClient(): MaxClientService {
          return owner.maxClient;
        },
        get chatContextCache(): ChatContextCacheService {
          return owner.chatContextCache;
        },
        get logger(): Logger {
          return owner.logger;
        },
        get maxBotLinkService(): MaxBotLinkService | undefined {
          return owner.maxBotLinkService;
        },
        get maxBotRegistry(): MaxBotRegistryService | undefined {
          return owner.maxBotRegistry;
        },
        normalizeRuntimeManagedEntityBotId: (botId) =>
          owner.normalizeRuntimeManagedEntityBotId(botId),
        resolveBotAssignment: (chatId) => owner.resolveBotAssignment(chatId),
        resolveCandidateBotIdsForChat: (chatId, options) =>
          owner.resolveCandidateBotIdsForChat(chatId, options),
        refreshManagedEntityBotAccessSnapshots: (chatId, entityType, reason) =>
          refreshBots(owner.maxBotExecutionPlanner, owner.logger, chatId, entityType, reason),
      }),
    ))(this);
  private readonly suggestionDeliveryRuntime = ((owner: AdminService) => {
    // FLAG: Resolve constructor-owned dependencies lazily and preserve their receivers.
    return new AdminSuggestionDeliveryRuntime(
      createAdminSuggestionDeliveryRuntimeContext({
        get logger() {
          return owner.logger;
        },
        get adminSuggestionDeliveryQueue() {
          return owner.adminSuggestionDeliveryQueue;
        },
        processChannelSuggestionDeliveryJobWithinTimeout: (auditLogId) =>
          owner.processChannelSuggestionDeliveryJobWithinTimeout(auditLogId),
      }),
    );
  })(this);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly managedEntitiesRuntimeBotIds: ReadonlySet<string>;
  private readonly maxBotToken: string;
  private readonly maxBotTokenValidationSecrets: readonly string[];
  private readonly dialogLinkHelper: AdminDialogLinkHelper;
  private readonly manualFanoutLookupSpacingMs: number;
  private readonly manualFanoutActionSpacingMs: number;
  private readonly superBanDeveloperUserIds: ReadonlySet<string>;
  private readonly managedEntitiesPublishedSnapshotReadEnabled: boolean;
  private readonly managedEntitiesPublishedSnapshotWriteEnabled: boolean;
  private readonly managedEntitiesPublishedDiffReadEnabled: boolean;
  private readonly managedEntitiesPublishedDiffWriteEnabled: boolean;
  private readonly adminAccessChecks = new Map<string, Promise<AdminAccessResolution>>();
  private readonly managedEntitiesDiscoveryChecks = new Map<
    string,
    Promise<ManagedEntitiesListResult>
  >();
  private readonly managedEntitiesRefreshCooldownUntilMs = new Map<string, number>();
  private readonly managedEntitiesRefreshBackoffUntilMs = new Map<string, number>();
  private readonly managedEntityHeaderHydrationRuns = new Map<string, Promise<void>>();
  private readonly recentBotAddedImmediateHeaderHydrationRuns = new Map<
    string,
    Promise<ChatSummary>
  >();
  private readonly managedEntitiesBackgroundRefreshRuns = new Map<string, Promise<void>>();

  private readonly managedEntitiesReadPrisma: PrismaClient | null;
  private readonly managedEntitiesResponseWarmupRuns = new Map<
    string,
    Promise<ManagedEntitiesListResult>
  >();
  private readonly managedEntitiesAllowlistWarmupRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesPublishedSnapshotRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesDiscoveryHeaderPrimeRuns = new Map<string, Promise<void>>();
  private readonly managedEntitiesDiscoveryHeaderPrimeCooldownUntilMs = new Map<string, number>();
  private readonly managedEntitiesCatalogSyncCursorByScope = new Map<string, number>();
  private managedEntitiesDegradePauseLogAtMs = 0;
  private readonly adminAccessValidationRosterSyncScheduledAtMs = new Map<string, number>();
  private readonly resolvedUserProfileCache = new Map<
    string,
    TimedPromiseCacheEntry<ResolvedUserProfile>
  >();
  private moderationSanctionStateLockFallback: ModerationSanctionStateLockService | null = null;
  private moderationSanctionStateFenceFallback: ModerationSanctionStateFenceService | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly channelStatsCollector?: ChannelStatsCollectorService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional()
    @InjectQueue(ADMIN_MANUAL_FANOUT_QUEUE)
    private readonly adminManualFanoutQueue?: Queue<AdminManualFanoutJob>,
    @Optional()
    @InjectQueue(ADMIN_SUGGESTION_DELIVERY_QUEUE)
    private readonly adminSuggestionDeliveryQueue?: Queue<AdminSuggestionDeliveryJob>,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly maxBotExecutionPlanner?: MaxBotExecutionPlannerService,
    @Optional()
    @InjectQueue(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE)
    private readonly adminManagedEntitiesRefreshQueue?: Queue<AdminManagedEntitiesRefreshJob>,
    @Optional() private readonly systemModeService?: SystemModeService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional()
    private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
    @Optional()
    private readonly globalSpammerIntelligence?: GlobalSpammerIntelligenceService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    @InjectQueue(ADMIN_SUPER_BAN_QUEUE)
    private readonly adminSuperBanQueue?: Queue<AdminSuperBanJob>,
    @Optional()
    private readonly managedEntityCandidateSyncService?: ManagedEntityCandidateSyncService,
    @Optional()
    private readonly maxRoutedPublicationService?: MaxRoutedPublicationService,
    @Optional()
    private readonly moderationDeleteIntentService?: ModerationDeleteIntentService,
    @Optional()
    private readonly manualMessageCleanupService?: AdminManualMessageCleanupService,
    @Optional()
    private readonly channelPostSignatureService?: ChannelPostSignatureService,
    @Optional()
    private readonly injectedModerationSanctionStateLock?: ModerationSanctionStateLockService,
    @Optional()
    private readonly injectedModerationSanctionStateFence?: ModerationSanctionStateFenceService,
    @Optional() private readonly publisherRuntimeBoundaryService?: PublisherRuntimeBoundaryService,
    @Optional() private readonly publisherReadinessService?: PublisherReadinessService,
    @Optional()
    private readonly publisherSuggestionPublicationQueue?: PublisherSuggestionPublicationQueueService,
    @Optional() private readonly publisherDispatchHealthService?: PublisherDispatchHealthService,
    @Optional()
    private readonly publisherChatCommentQueueService?: PublisherChatCommentQueueService,
    @Optional()
    private readonly publisherDialogContextService?: PublisherDialogContextService,
    @Optional()
    private readonly publisherDialogLinkService?: PublisherDialogLinkService,
    @Optional()
    private readonly publisherSuggestionAdminQueueService?: PublisherSuggestionAdminQueueService,
    @Optional() private readonly reports?: ReportViewService,
    @Optional() readonly suggestionSubscriptions?: SuggestionSubscriptionService,
    @Optional()
    private readonly publisherCommentNotifications?: PublisherCommentNotificationService,
    @Optional() private readonly entityPresentation?: ManagedEntityPresentationService,
    @Optional() private readonly statisticsExchange?: StatisticsExchangeAudienceService,
  ) {
    this.publisherCommentKeyboardRouting = new PublisherCommentKeyboardRouting(
      this.maxBotRegistry,
      this.publisherChatCommentQueueService,
      this.logger,
    );
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    this.maxBotToken =
      this.maxBotLinkService?.getBotTokenSync?.() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens?.() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [this.maxBotToken]);
    this.appBaseUrl = normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.superBanDeveloperUserIds = this.parseSuperBanDeveloperUserIds(
      configService.get<string>('SUPER_BAN_DEVELOPER_USER_IDS'),
    );
    this.explicitBotContactId = normalizeBotContactId(
      configService.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID'));
    this.dialogLinkHelper = new AdminDialogLinkHelper({
      appBaseUrl: this.appBaseUrl,
      explicitBotContactId: this.explicitBotContactId,
      ownBotUserId: this.ownBotUserId,
      maxBotToken: this.maxBotToken,
      maxBotTokenValidationSecrets: this.maxBotTokenValidationSecrets,
      maxBotLinkService: this.maxBotLinkService,
      maxBotRegistry: this.maxBotRegistry,
    });
    this.publisherDialogProfileRuntime = new PublisherDialogProfileRuntime({
      prisma: this.prisma,
      majorDialogLinks: this.dialogLinkHelper,
      publisherDialogLinks: this.publisherDialogLinkService,
      publisherReadiness: this.publisherReadinessService,
      maxBotRegistry: this.maxBotRegistry,
      enqueueSuggestionAdminDelivery: (suggestionId) =>
        this.enqueuePublisherSuggestionAdminDelivery(suggestionId),
      suggestionSubscriptions: this.suggestionSubscriptions,
      commentNotifications: this.publisherCommentNotifications,
    });
    this.dialogAdminAccessRuntime = new AdminDialogAdminAccessRuntime({
      prisma: this.prisma,
      maxClient: this.maxClient,
      logger: this.logger,
      maxChatAdminRosterSyncService: this.maxChatAdminRosterSyncService,
      resolveBackgroundReadBotAssignment: async (chatId) =>
        (await this.resolveBackgroundReadBotAssignment(chatId)) ?? null,
    });
    const registryBotIds =
      typeof this.maxBotRegistry?.getOperationalBots === 'function'
        ? this.maxBotRegistry.getOperationalBots().map((bot) => bot.id)
        : typeof this.maxBotRegistry?.getAllBots === 'function'
          ? this.maxBotRegistry.getAllBots().map((bot) => bot.id)
          : [];
    this.managedEntitiesRuntimeBotIds = new Set(
      [...registryBotIds, this.readTrimmedString(configService.get<string>('MAX_BOT_ID'))].filter(
        (botId): botId is string => Boolean(botId),
      ),
    );
    this.manualFanoutLookupSpacingMs = readNonNegativeConfigInt(
      configService.get<number>('MANUAL_FANOUT_LOOKUP_SPACING_MS'),
      process.env.NODE_ENV === 'test' ? 0 : 180,
    );
    this.manualFanoutActionSpacingMs = readNonNegativeConfigInt(
      configService.get<number>('MANUAL_FANOUT_ACTION_SPACING_MS'),
      process.env.NODE_ENV === 'test' ? 0 : 120,
    );
    this.managedEntitiesPublishedSnapshotReadEnabled = readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_SNAPSHOT_READ_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedSnapshotWriteEnabled = readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_SNAPSHOT_WRITE_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedDiffReadEnabled = readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_DIFF_READ_ENABLED'),
      true,
    );
    this.managedEntitiesPublishedDiffWriteEnabled = readBooleanConfigFlag(
      configService.get<string>('MANAGED_ENTITIES_DIFF_WRITE_ENABLED'),
      true,
    );
    this.managedEntitiesReadPrisma = this.createManagedEntitiesReadPrisma(
      configService.get<string>('DATABASE_URL'),
      {
        max: readPositiveConfigInt(
          configService.get<number>('MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX'),
          2,
        ),
        idleTimeoutMillis: readPositiveConfigInt(
          configService.get<number>('PRISMA_PG_POOL_IDLE_TIMEOUT_MS') ??
            configService.get<number>('PRISMA_POOL_IDLE_TIMEOUT_MS'),
          10_000,
        ),
        connectionTimeoutMillis: readPositiveConfigInt(
          configService.get<number>('PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS') ??
            configService.get<number>('PRISMA_POOL_CONNECTION_TIMEOUT_MS'),
          5_000,
        ),
        application_name: `${configService.get<string>('APP_SERVICE_NAME') ?? 'api-admin'}:managed-entities-read`,
      },
    );
  }

  private get moderationSanctionStateLock(): ModerationSanctionStateLockService {
    if (this.injectedModerationSanctionStateLock) {
      return this.injectedModerationSanctionStateLock;
    }
    if (!this.moderationSanctionStateLockFallback) {
      this.moderationSanctionStateLockFallback = new ModerationSanctionStateLockService(
        this.redisCounter,
      );
    }
    return this.moderationSanctionStateLockFallback;
  }

  private get moderationSanctionStateFence(): ModerationSanctionStateFenceService {
    if (this.injectedModerationSanctionStateFence) {
      return this.injectedModerationSanctionStateFence;
    }
    if (!this.moderationSanctionStateFenceFallback) {
      this.moderationSanctionStateFenceFallback = new ModerationSanctionStateFenceService(
        this.prisma,
      );
    }
    return this.moderationSanctionStateFenceFallback;
  }

  async onModuleDestroy(): Promise<void> {
    await this.managedEntitiesReadPrisma?.$disconnect();
  }

  private createManagedEntitiesReadPrisma(
    databaseUrl: string | null | undefined,
    poolConfig: PrismaPoolConfig,
  ): PrismaClient | null {
    const dedicatedUrl = this.buildManagedEntitiesReadDatabaseUrl(databaseUrl);
    if (!dedicatedUrl) {
      return null;
    }

    return createPrismaClient(dedicatedUrl, poolConfig);
  }

  private buildManagedEntitiesReadDatabaseUrl(databaseUrl?: string | null): string | null {
    const normalized = databaseUrl?.trim();
    if (!normalized) {
      return null;
    }

    try {
      return new URL(normalized).toString();
    } catch {
      return null;
    }
  }

  private getManagedEntitiesReadPrisma():
    | PrismaClient
    | Pick<PrismaService, 'chatAdminAllowlist' | '$queryRaw' | 'chat'> {
    return this.managedEntitiesReadPrisma ?? this.prisma;
  }

  async listChats(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return this.managedEntitiesRuntime.listChats(user, options);
  }

  async listChatsForMassBroadcast(
    user: AuthUser,
    options: {
      discoveryMode?: 'full' | 'cached-first';
    } = {},
  ): Promise<ChatSummary[]> {
    return this.managedEntitiesRuntime.listChatsForMassBroadcast(user, options);
  }

  async listChannels(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return this.managedEntitiesRuntime.listChannels(user, options);
  }

  async listChatsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return this.managedEntitiesRuntime.listChatsWithRefreshState(user, options);
  }

  async listChannelsWithRefreshState(
    user: AuthUser,
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResponse> {
    return this.managedEntitiesRuntime.listChannelsWithRefreshState(user, options);
  }

  async listManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ChatSummary[]> {
    return this.managedEntitiesRuntime.listManagedEntities(user, entityType, options);
  }

  listManagedEntitiesDetailedForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResult> {
    return this.managedEntitiesRuntime.listManagedEntitiesDetailedForManagedEntities(
      user,
      entityType,
      options,
    );
  }

  createIdleManagedEntitiesRefreshStateForManagedEntities(): ManagedEntitiesRefreshState {
    return this.managedEntitiesRuntime.createIdleManagedEntitiesRefreshStateForManagedEntities();
  }

  async previewApplySettingsSectionTarget(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ApplySectionTargetPreviewResponse> {
    await this.assertManagedEntityAdminAccess(sourceChatId, user.userId, 'chat');
    return previewApplySettingsSectionTargetValue({
      sourceChatId,
      body,
      resolveTargetChats: (target) =>
        this.resolveSettingsApplyTargetChatsForSettings(sourceChatId, user, target),
    });
  }

  async getChatHeader(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return this.managedEntitiesRuntime.getChatHeader(chatId, user, options);
  }

  async getChannelHeader(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    return this.managedEntitiesRuntime.getChannelHeader(chatId, user, options);
  }

  private async listManagedEntitiesDetailed(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter = 'all',
    options: ManagedEntitiesListOptions = {},
  ): Promise<ManagedEntitiesListResult> {
    const lightweightBootstrapPromises = new Map<
      number,
      Promise<{
        recentBotAdded: ChatSummary[];
      }>
    >();
    const loadLightweightBootstrap = async (options: { adminCheckLimit?: number } = {}) => {
      const adminCheckLimit = Math.max(
        0,
        Math.trunc(options.adminCheckLimit ?? RECENT_BOT_ADDED_BOOTSTRAP_MAX_ADMIN_CHECKS),
      );
      let lightweightBootstrapPromise = lightweightBootstrapPromises.get(adminCheckLimit);
      if (!lightweightBootstrapPromise) {
        lightweightBootstrapPromise = this.loadManagedEntitiesLightweightBootstrap(
          user,
          entityType,
          { adminCheckLimit },
        );
        lightweightBootstrapPromises.set(adminCheckLimit, lightweightBootstrapPromise);
      }

      return lightweightBootstrapPromise;
    };
    const mergeWithLightweightBootstrap = async (
      items: readonly ChatSummary[],
      options: { adminCheckLimit?: number } = {},
    ): Promise<ChatSummary[]> => {
      return this.mergeManagedEntitiesWithLightweightBootstrap(
        items,
        await loadLightweightBootstrap(options),
      );
    };
    const mergePublishedSnapshotWithLightweightBootstrap = async (
      items: readonly ChatSummary[],
    ): Promise<ChatSummary[]> => {
      return this.mergeManagedEntitiesPublishedSnapshotWithLightweightBootstrap(
        items,
        await loadLightweightBootstrap(),
      );
    };

    if (options.refresh !== true) {
      if (options.fresh === true) {
        try {
          const fresh = await this.discoverManagedEntitiesFromLocalCatalog(user, entityType, {
            respectCooldown: false,
            fullScan: false,
            includeRefreshState: options.includeRefreshState === true,
          });
          const remainingFreshAdminCheckBudget = Math.max(
            0,
            MANAGED_ENTITIES_FOREGROUND_CANDIDATE_CHECK_LIMIT -
              this.readManagedEntitiesAdminCheckCount(fresh),
          );
          const mergedFresh = await mergeWithLightweightBootstrap(fresh.items, {
            adminCheckLimit: remainingFreshAdminCheckBudget,
          });
          const items = await this.attachManagedEntityBotAssignments(mergedFresh);
          this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
            deferStart: true,
          });
          this.scheduleManagedEntitiesPublishedSnapshotRebuild(user.userId, entityType);
          return {
            items,
            refresh: fresh.refresh,
          };
        } catch {
          // Fall back to the persisted allowlist only when the live refresh itself fails.
        }
      }

      const publishedSnapshot = await this.readManagedEntitiesPublishedSnapshotForResponse(
        user.userId,
        entityType,
      );
      if (publishedSnapshot) {
        const items = await mergePublishedSnapshotWithLightweightBootstrap(publishedSnapshot.items);
        this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
          deferStart: true,
        });
        const refreshState =
          options.includeRefreshState === true
            ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType)
            : null;
        return {
          items,
          refresh: refreshState,
          snapshot: this.createManagedEntitiesResponseSnapshotMetadata(
            publishedSnapshot,
            refreshState,
          ),
        };
      }

      const cached = await this.revalidateCachedManagedEntities(
        user,
        await this.listChatsFromAllowlistWithinResponseBudget(user.userId, entityType, {
          source: 'default',
        }),
      );
      const edgeItems = await this.listManagedEntitiesFromFreshAccessEdgesWithinResponseBudget(
        user.userId,
        entityType,
        new Set(cached.map((item) => item.id)),
        { source: 'default' },
      );
      const cachedWithEdges = mergeManagedEntityGroups(cached, edgeItems);
      const initial = await mergeWithLightweightBootstrap(cachedWithEdges);
      if (edgeItems.length > 0) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuild(user.userId, entityType);
      }
      if (cachedWithEdges.length === 0) {
        this.scheduleManagedEntitiesPriorityAllowlistWarmup(user, entityType, {
          seededChats: initial,
        });
      }
      if (initial.length > 0) {
        const items = await this.attachManagedEntityBotAssignments(
          await this.hydrateManagedEntities(initial),
        );
        this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
          deferStart: true,
        });
        return {
          items,
          refresh:
            options.includeRefreshState === true
              ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType)
              : null,
        };
      }

      const warmupPromise = this.startManagedEntitiesResponseWarmup(user, entityType, {
        includeRefreshState: options.includeRefreshState === true,
      });
      const discovered = warmupPromise
        ? await this.awaitManagedEntitiesResponseValueWithinBudget(warmupPromise, {
            fallback: {
              items: [],
              refresh: null,
            },
            budgetMs: MANAGED_ENTITIES_RESPONSE_WARMUP_BUDGET_MS,
            timeoutMessage:
              'Detached managed entities discovery warmup from default response after response budget exceeded',
            failureMessage: 'Managed entities discovery warmup failed during default response',
            logData: {
              entityType,
              source: 'default',
              userId: user.userId,
            },
          })
        : {
            items: [],
            refresh: null,
          };
      const discoveredItems = mergeManagedEntityGroups(initial, discovered.items);
      const items =
        discoveredItems.length > 0
          ? await this.attachManagedEntityBotAssignments(
              await this.hydrateManagedEntities(discoveredItems),
            )
          : [];
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
        deferStart: true,
      });

      return {
        items,
        refresh: discovered.refresh,
      };
    }

    const refresh = await this.scheduleManagedEntitiesBoundedRefresh(user, entityType, {
      bypassRemoteCache: options.bypassRemoteCache === true,
      resetRefreshCursor: options.resetRefreshCursor === true,
    });
    const publishedSnapshot = await this.readManagedEntitiesPublishedSnapshotForResponse(
      user.userId,
      entityType,
    );
    if (publishedSnapshot) {
      const bootstrap =
        options.sinceVersion !== undefined ? await loadLightweightBootstrap() : null;
      const snapshotIds =
        bootstrap !== null ? new Set(publishedSnapshot.items.map((item) => item.id)) : null;
      const hasBootstrapOutsideSnapshot =
        bootstrap !== null && bootstrap.recentBotAdded.some((item) => !snapshotIds?.has(item.id));
      if (!hasBootstrapOutsideSnapshot) {
        const diffResponse = await this.readManagedEntitiesPublishedDiffResponseForRefresh(
          user.userId,
          entityType,
          options.sinceVersion,
          publishedSnapshot,
          refresh,
          {
            bypassRemoteCache: options.bypassRemoteCache === true,
            resetRefreshCursor: options.resetRefreshCursor === true,
          },
        );
        if (diffResponse) {
          this.scheduleManagedEntityHeaderHydration(
            user.userId,
            entityType,
            publishedSnapshot.items,
            { deferStart: true },
          );
          return diffResponse;
        }
      }

      const snapshotItems =
        options.bypassRemoteCache === true ||
        options.resetRefreshCursor === true ||
        hasBootstrapOutsideSnapshot
          ? await mergePublishedSnapshotWithLightweightBootstrap(publishedSnapshot.items)
          : publishedSnapshot.items;
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, snapshotItems);
      return {
        items: snapshotItems,
        refresh,
        snapshot: this.createManagedEntitiesResponseSnapshotMetadata(publishedSnapshot, refresh),
      };
    }
    const cached = await this.revalidateCachedManagedEntities(
      user,
      await this.listChatsFromAllowlistWithinResponseBudget(user.userId, entityType, {
        source: 'refresh',
      }),
    );
    const responseWarmupPromise =
      cached.length === 0
        ? this.startManagedEntitiesResponseWarmup(user, entityType, {
            includeRefreshState: false,
          })
        : null;
    const responseWarmup = responseWarmupPromise
      ? await this.awaitManagedEntitiesResponseValueWithinBudget(responseWarmupPromise, {
          fallback: {
            items: [],
            refresh: null,
          },
          budgetMs: MANAGED_ENTITIES_RESPONSE_WARMUP_BUDGET_MS,
          timeoutMessage:
            'Detached managed entities discovery warmup from refresh response after response budget exceeded',
          failureMessage: 'Managed entities discovery warmup failed during refresh response',
          logData: {
            entityType,
            source: 'refresh',
            userId: user.userId,
          },
        })
      : null;
    // If no published snapshot exists yet, prefer showing lightweight bootstrap candidates
    // over returning a temporarily empty refresh response.
    const shouldMergeLightweightBootstrap = true;
    const edgeItems = await this.listManagedEntitiesFromFreshAccessEdgesWithinResponseBudget(
      user.userId,
      entityType,
      new Set(cached.map((item) => item.id)),
      { source: 'refresh' },
    );
    const responseBaseItems =
      responseWarmup && responseWarmup.items.length > 0
        ? mergeManagedEntityGroups(responseWarmup.items, cached, edgeItems)
        : mergeManagedEntityGroups(cached, edgeItems);
    const mergedCached = shouldMergeLightweightBootstrap
      ? await mergeWithLightweightBootstrap(responseBaseItems)
      : responseBaseItems;
    const items =
      mergedCached.length > 0
        ? await this.attachManagedEntityBotAssignments(
            await this.hydrateManagedEntities(mergedCached),
          )
        : [];
    this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items);
    this.scheduleManagedEntitiesPublishedSnapshotRebuild(user.userId, entityType);
    return {
      items,
      refresh,
    };
  }

  private supportsManagedEntitiesPublishedSnapshot(
    entityType: ManagedEntityTypeFilter,
  ): entityType is ManagedEntityType {
    return entityType === 'chat' || entityType === 'channel';
  }

  private buildManagedEntitiesPublishedSnapshotRunKey(
    userId: string,
    entityType: ManagedEntityType,
  ): string {
    return `${userId}:${entityType}:published-snapshot`;
  }

  private async readManagedEntitiesPublishedSnapshotForResponse(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ManagedEntitiesPublishedSnapshotReadResult | null> {
    if (
      !this.managedEntitiesPublishedSnapshotReadEnabled ||
      !this.supportsManagedEntitiesPublishedSnapshot(entityType) ||
      typeof this.chatContextCache.getManagedEntitiesPublishedSnapshot !== 'function'
    ) {
      return null;
    }

    try {
      const snapshot = await this.chatContextCache.getManagedEntitiesPublishedSnapshot(
        userId,
        entityType,
      );
      if (!snapshot) {
        return null;
      }

      const runtimeScopedItems = this.filterManagedEntitiesToRuntimeScope(
        snapshot.items.map((item) => this.cloneManagedEntitySummary(item)),
        { requireKnownBot: true },
      );
      if (runtimeScopedItems.length !== snapshot.items.length) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
      }
      const strictVisibleItems = await this.filterManagedEntitiesByStrictAccessEdges(
        userId,
        runtimeScopedItems,
      );
      const repairedItems = await this.repairManagedEntityAccessEdgesFromAllowlist(
        userId,
        runtimeScopedItems,
        strictVisibleItems,
      );
      const edgeVisibleItems = this.filterManagedEntitiesByVisibleIdsInSourceOrder(
        runtimeScopedItems,
        strictVisibleItems,
        repairedItems,
      );
      const filteredItems = await this.filterManagedEntitiesByCachedDeniedAccess(
        userId,
        edgeVisibleItems,
        { ignoreBotDenied: true },
      );
      const responseItems =
        await this.mergeManagedEntitiesPublishedSnapshotWithFreshAccessEdgeItems(
          userId,
          entityType,
          filteredItems,
        );
      const hydratedItems = await this.attachManagedEntityAvatars(responseItems);
      const responseSnapshot =
        this.managedEntitiesPublishedSnapshotWriteEnabled &&
        this.supportsManagedEntitiesPublishedSnapshot(entityType)
          ? await publishManagedEntityHeaderChanges({
              cache: this.chatContextCache,
              userId,
              entityType,
              snapshot,
              visibleItems: hydratedItems,
              writeDiff: this.managedEntitiesPublishedDiffWriteEnabled,
            })
          : snapshot;
      if (!responseSnapshot) return null;
      if (!this.haveSameManagedEntityIds(responseItems, runtimeScopedItems)) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
      }

      return {
        items: hydratedItems,
        version: responseSnapshot.version,
        builtAt: responseSnapshot.builtAt,
        lastSyncedAt: responseSnapshot.lastSyncedAt,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read managed entities published snapshot',
      );
      return null;
    }
  }

  private createManagedEntitiesResponseSnapshotMetadata(
    snapshot: ManagedEntitiesPublishedSnapshotReadResult,
    refresh: ManagedEntitiesRefreshState | null,
  ): ManagedEntitiesResponseSnapshot {
    const stale =
      !refresh ||
      refresh.complete !== true ||
      refresh.backoffActive === true ||
      (typeof refresh.cursor === 'number' && refresh.cursor >= 0);

    return {
      version: snapshot.version,
      builtAt: snapshot.builtAt,
      lastSyncedAt: snapshot.lastSyncedAt,
      source: 'published_snapshot',
      stale,
    };
  }

  private async filterManagedEntitiesPublishedSnapshotDeniedItems(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    const strictVisibleItems = await this.filterManagedEntitiesByStrictAccessEdges(userId, items);
    return this.filterManagedEntitiesByCachedDeniedAccess(userId, strictVisibleItems, {
      ignoreBotDenied: true,
    });
  }

  private async filterManagedEntitiesByCachedDeniedAccess(
    userId: string,
    items: readonly ChatSummary[],
    options: { ignoreBotDenied?: boolean } = {},
  ): Promise<ChatSummary[]> {
    if (items.length === 0 || typeof this.chatContextCache.getAdminAccess !== 'function') {
      return items.map((item) => this.cloneManagedEntitySummary(item));
    }

    const accessStates = await Promise.all(
      items.map(async (item) => {
        try {
          return {
            item,
            access: await this.chatContextCache.getAdminAccess(item.id, userId),
          };
        } catch {
          return {
            item,
            access: null,
          };
        }
      }),
    );

    return accessStates
      .filter(
        ({ access }) =>
          access !== 'user_denied' && (options.ignoreBotDenied === true || access !== 'bot_denied'),
      )
      .map(({ item }) => this.cloneManagedEntitySummary(item));
  }

  private filterManagedEntitiesByVisibleIdsInSourceOrder(
    sourceItems: readonly ChatSummary[],
    ...visibleGroups: readonly ChatSummary[][]
  ): ChatSummary[] {
    const visibleIds = new Set<string>();
    for (const group of visibleGroups) {
      for (const item of group) {
        visibleIds.add(item.id);
      }
    }

    return sourceItems
      .filter((item) => visibleIds.has(item.id))
      .map((item) => this.cloneManagedEntitySummary(item));
  }

  private haveSameManagedEntityIds(
    leftItems: readonly ChatSummary[],
    rightItems: readonly ChatSummary[],
  ): boolean {
    return (
      leftItems.length === rightItems.length &&
      leftItems.every((item, index) => item.id === rightItems[index]?.id)
    );
  }

  private async mergeManagedEntitiesPublishedSnapshotWithFreshAccessEdgeItems(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    const snapshotItems = items.map((item) => this.cloneManagedEntitySummary(item));
    if (!this.supportsManagedEntitiesPublishedSnapshot(entityType)) {
      return snapshotItems;
    }

    try {
      const edgeItems = await this.listManagedEntitiesFromFreshAccessEdgesWithinResponseBudget(
        userId,
        entityType,
        new Set(snapshotItems.map((item) => item.id)),
        { source: 'published_snapshot' },
      );
      if (edgeItems.length === 0) {
        return snapshotItems;
      }

      this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
      return mergeManagedEntityGroups(snapshotItems, edgeItems);
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to merge fresh access-edge managed entities into published snapshot response',
      );
      return snapshotItems;
    }
  }

  private listManagedEntitiesFromFreshAccessEdgesWithinResponseBudget(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    excludeIds: ReadonlySet<string>,
    options: {
      source: 'default' | 'refresh' | 'published_snapshot';
    },
  ): Promise<ChatSummary[]> {
    if (!this.supportsManagedEntitiesPublishedSnapshot(entityType)) {
      return Promise.resolve([]);
    }

    return this.awaitManagedEntitiesResponseValueWithinBudget(
      this.listManagedEntitiesFromFreshAccessEdges(userId, entityType, excludeIds),
      {
        fallback: [],
        budgetMs: MANAGED_ENTITIES_ACCESS_EDGE_RESPONSE_BUDGET_MS,
        timeoutMessage:
          'Detached managed entities access-edge read from response after response budget exceeded',
        failureMessage:
          'Managed entities access-edge read failed during user-facing managed entities response',
        logData: {
          entityType,
          source: options.source,
          userId,
        },
      },
    );
  }

  private async listManagedEntitiesFromFreshAccessEdges(
    userId: string,
    entityType: ManagedEntityType,
    excludeIds: ReadonlySet<string> = new Set(),
  ): Promise<ChatSummary[]> {
    const client = (
      this.prisma as unknown as {
        managedEntityAccessEdge?: {
          findMany?: (args: unknown) => Promise<
            Array<{
              chatId: string;
              botId: string;
              checkedAt?: Date | null;
              chat?: {
                id: string;
                title: string;
                createdAt: Date;
                entityType: ChatEntityType;
                primaryBotId?: string | null;
                botId?: string | null;
              } | null;
            }>
          >;
        };
      }
    ).managedEntityAccessEdge;
    if (typeof client?.findMany !== 'function') {
      return [];
    }

    const normalizedExcludeIds = Array.from(
      new Set(
        [...excludeIds]
          .map((chatId) => this.readTrimmedString(chatId))
          .filter((chatId): chatId is string => Boolean(chatId)),
      ),
    );
    const runtimeBotIds = [...this.managedEntitiesRuntimeBotIds];

    try {
      const rows = await client.findMany({
        where: {
          userId,
          entityType: toPrismaEntityType(entityType),
          state: 'GRANTED',
          ...(runtimeBotIds.length > 0
            ? {
                botId: {
                  in: runtimeBotIds,
                },
              }
            : {}),
          ...(normalizedExcludeIds.length > 0
            ? {
                chatId: {
                  notIn: normalizedExcludeIds,
                },
              }
            : {}),
          OR: [
            { expiresAt: { gt: new Date() } },
            {
              expiresAt: null,
              checkedAt: { gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS) },
            },
          ],
        },
        select: {
          chatId: true,
          botId: true,
          checkedAt: true,
          chat: {
            select: {
              id: true,
              title: true,
              createdAt: true,
              entityType: true,
              primaryBotId: true,
              botId: true,
            },
          },
        },
        orderBy: [{ checkedAt: 'desc' }],
        take: MANAGED_ENTITIES_ACCESS_EDGE_RESPONSE_LIMIT,
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        return [];
      }

      const activeMembershipKeys = await this.readActiveManagedEntityMembershipKeys(rows, {
        userId,
        requestedItems: rows.length,
        source: 'fresh_access_edges',
      });
      const summaries: ChatSummary[] = [];
      const seenChatIds = new Set<string>();
      for (const row of rows) {
        const chatId = this.readTrimmedString(row.chatId);
        const botId = this.normalizeManagedEntityAccessBotId(row.botId);
        const chat = row.chat;
        if (
          !chatId ||
          !botId ||
          !chat ||
          seenChatIds.has(chatId) ||
          !activeMembershipKeys.has(this.buildManagedEntityRepairEdgeKey(chatId, botId))
        ) {
          continue;
        }

        const resolvedEntityType = fromPrismaEntityType(chat.entityType);
        if (
          resolvedEntityType !== entityType ||
          isUnsupportedManagedChat(chat.id, resolvedEntityType)
        ) {
          continue;
        }

        const chatPrimaryBotId =
          this.normalizeRuntimeManagedEntityBotId(
            this.readTrimmedString(chat.primaryBotId) ?? this.readTrimmedString(chat.botId),
          ) ?? botId;
        seenChatIds.add(chatId);
        summaries.push(
          this.createManagedEntitySummary({
            id: chat.id,
            title: chat.title,
            createdAt: chat.createdAt.toISOString(),
            entityType: resolvedEntityType,
            primaryBotId: chatPrimaryBotId,
          }),
        );
      }

      if (summaries.length === 0) {
        return [];
      }

      const enrichedItems = await this.attachChannelOverview(
        await this.attachManagedEntityAvatars(summaries),
      );
      const strictVisibleItems = await this.filterManagedEntitiesByStrictAccessEdges(
        userId,
        enrichedItems,
      );
      return this.filterManagedEntitiesByCachedDeniedAccess(userId, strictVisibleItems, {
        ignoreBotDenied: true,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read managed entities from fresh access edges',
      );
      return [];
    }
  }

  private async filterManagedEntitiesByStrictAccessEdges(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (items.length === 0) {
      return [];
    }

    const client = this.getManagedEntityAccessEdgeClient();
    if (!client) {
      return [...items];
    }

    const chatIds = Array.from(
      new Set(items.map((item) => item.id.trim()).filter((chatId) => chatId.length > 0)),
    );
    if (chatIds.length === 0) {
      return [];
    }

    try {
      const rows = await client.findMany({
        where: {
          userId,
          chatId: {
            in: chatIds,
          },
          OR: [
            {
              state: 'USER_DENIED',
            },
            {
              state: 'GRANTED',
              OR: [
                { expiresAt: { gt: new Date() } },
                {
                  expiresAt: null,
                  checkedAt: {
                    gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS),
                  },
                },
              ],
            },
          ],
        },
        select: {
          chatId: true,
          botId: true,
          state: true,
          checkedAt: true,
        },
      });
      // FLAG: Publisher denials cannot hide a separately authorized moderation connection.
      const publisherBotId = this.maxBotRegistry?.getPublisherBotDescriptor?.().id;
      const scopedRows = rows.filter((row) => !publisherBotId || row.botId !== publisherBotId);
      const grantedRows = scopedRows.filter((row) => !row.state || row.state === 'GRANTED');
      const activeMembershipKeys = await this.readActiveManagedEntityMembershipKeys(grantedRows, {
        userId,
        requestedItems: items.length,
        source: 'strict_access_edges',
      });
      const newestUserDeniedAtByChatId = new Map<string, number>();
      for (const row of scopedRows) {
        if (row.state !== 'USER_DENIED') {
          continue;
        }
        const chatId = this.readTrimmedString(row.chatId);
        if (!chatId) {
          continue;
        }
        const deniedAt = row.checkedAt?.getTime() ?? Number.POSITIVE_INFINITY;
        newestUserDeniedAtByChatId.set(
          chatId,
          Math.max(newestUserDeniedAtByChatId.get(chatId) ?? Number.NEGATIVE_INFINITY, deniedAt),
        );
      }
      const visibleChatIds = new Set(
        grantedRows
          .filter((row) => {
            const chatId = this.readTrimmedString(row.chatId);
            const botId = this.normalizeManagedEntityAccessBotId(row.botId);
            const newestUserDeniedAt = chatId ? newestUserDeniedAtByChatId.get(chatId) : undefined;
            const grantedAt = row.checkedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
            return (
              Boolean(chatId && botId) &&
              (newestUserDeniedAt === undefined || grantedAt > newestUserDeniedAt) &&
              activeMembershipKeys.has(
                this.buildManagedEntityRepairEdgeKey(chatId ?? '', botId ?? ''),
              )
            );
          })
          .map((row) => this.readTrimmedString(row.chatId) ?? row.chatId),
      );

      return items
        .filter((item) => visibleChatIds.has(item.id))
        .map((item) => this.cloneManagedEntitySummary(item));
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          requestedItems: items.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to filter managed entities by strict access edges',
      );
      throw new ServiceUnavailableException('Managed entity access verification is unavailable');
    }
  }

  private async readActiveManagedEntityMembershipKeys(
    rows: ReadonlyArray<{ chatId: string; botId: string }>,
    context: {
      userId: string;
      requestedItems: number;
      source: string;
    },
  ): Promise<Set<string>> {
    const normalizedRows = rows
      .map((row) => {
        const chatId = this.readTrimmedString(row.chatId);
        const botId = this.normalizeManagedEntityAccessBotId(row.botId);
        if (!chatId || !botId || !this.isManagedEntityAccessBotInRuntimeScope(botId)) {
          return null;
        }
        return { chatId, botId };
      })
      .filter((row): row is { chatId: string; botId: string } => row !== null);
    if (normalizedRows.length === 0) {
      return new Set();
    }

    const memberships = (this.prisma as unknown as { chatBotMembership?: unknown })
      .chatBotMembership;
    if (!memberships || typeof memberships !== 'object') {
      return new Set(
        normalizedRows.map((row) => this.buildManagedEntityRepairEdgeKey(row.chatId, row.botId)),
      );
    }

    const membershipClient = memberships as {
      findMany?: (args: unknown) => Promise<Array<{ chatId: string; botId: string }>>;
    };
    if (typeof membershipClient.findMany !== 'function') {
      return new Set(
        normalizedRows.map((row) => this.buildManagedEntityRepairEdgeKey(row.chatId, row.botId)),
      );
    }

    const chatIds = Array.from(new Set(normalizedRows.map((row) => row.chatId)));
    const botIds = Array.from(new Set(normalizedRows.map((row) => row.botId)));
    try {
      const activeMemberships = await membershipClient.findMany({
        where: {
          chatId: {
            in: chatIds,
          },
          botId: {
            in: botIds,
          },
          status: ChatBotMembershipStatus.ACTIVE,
        },
        select: {
          chatId: true,
          botId: true,
        },
      });
      const requestedKeys = new Set(
        normalizedRows.map((row) => this.buildManagedEntityRepairEdgeKey(row.chatId, row.botId)),
      );
      return new Set(
        activeMemberships
          .map((row) => {
            const chatId = this.readTrimmedString(row.chatId);
            const botId = this.normalizeManagedEntityAccessBotId(row.botId);
            return chatId && botId ? this.buildManagedEntityRepairEdgeKey(chatId, botId) : null;
          })
          .filter((key): key is string => key !== null && requestedKeys.has(key)),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId: context.userId,
          requestedItems: context.requestedItems,
          source: context.source,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to filter managed entities by active bot membership',
      );
      throw new ServiceUnavailableException(
        'Managed entity membership verification is unavailable',
      );
    }
  }

  private normalizeManagedEntitiesSnapshotVersion(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private async readManagedEntitiesPublishedDiffResponseForRefresh(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    sinceVersion: string | undefined,
    publishedSnapshot: ManagedEntitiesPublishedSnapshotReadResult,
    refresh: ManagedEntitiesRefreshState,
    options: {
      bypassRemoteCache: boolean;
      resetRefreshCursor: boolean;
    },
  ): Promise<ManagedEntitiesListResult | null> {
    if (
      !this.managedEntitiesPublishedDiffReadEnabled ||
      !this.supportsManagedEntitiesPublishedSnapshot(entityType) ||
      options.bypassRemoteCache ||
      options.resetRefreshCursor
    ) {
      return null;
    }

    const normalizedSinceVersion = this.normalizeManagedEntitiesSnapshotVersion(sinceVersion);
    if (!normalizedSinceVersion) {
      return null;
    }

    const snapshot = this.createManagedEntitiesResponseSnapshotMetadata(publishedSnapshot, refresh);
    if (normalizedSinceVersion === publishedSnapshot.version) {
      return {
        items: [],
        refresh,
        snapshot,
        diff: {
          mode: 'noop',
          baseVersion: normalizedSinceVersion,
          nextVersion: publishedSnapshot.version,
        },
      };
    }

    const publishedDiff = await this.readManagedEntitiesPublishedDiffForResponse(
      userId,
      entityType,
      normalizedSinceVersion,
      publishedSnapshot.version,
    );
    if (!publishedDiff) {
      return null;
    }

    const nextRuntimeIds = new Set(publishedSnapshot.items.map((item) => item.id));

    return {
      items: [],
      refresh,
      snapshot,
      diff: {
        mode: 'patch',
        baseVersion: publishedDiff.baseVersion,
        nextVersion: publishedDiff.nextVersion,
        added: publishedDiff.added.filter((item) => nextRuntimeIds.has(item.id)),
        updated: publishedDiff.updated.filter((item) => nextRuntimeIds.has(item.id)),
        removedIds: publishedDiff.removedIds,
        orderedIds: publishedDiff.orderedIds.filter((item) => nextRuntimeIds.has(item)),
      },
    };
  }

  private async readManagedEntitiesPublishedDiffForResponse(
    userId: string,
    entityType: ManagedEntityType,
    baseVersion: string,
    expectedNextVersion: string,
  ): Promise<ManagedEntitiesPublishedDiffReadResult | null> {
    if (
      !this.managedEntitiesPublishedDiffReadEnabled ||
      typeof this.chatContextCache.getManagedEntitiesPublishedDiff !== 'function'
    ) {
      return null;
    }

    try {
      const diff = await this.chatContextCache.getManagedEntitiesPublishedDiff(
        userId,
        entityType,
        baseVersion,
      );
      if (!diff || diff.nextVersion !== expectedNextVersion) {
        return null;
      }

      return {
        baseVersion: diff.baseVersion,
        nextVersion: diff.nextVersion,
        added: this.filterManagedEntitiesToRuntimeScope(
          diff.added.map((item) => this.cloneManagedEntitySummary(item)),
          { requireKnownBot: true },
        ),
        updated: this.filterManagedEntitiesToRuntimeScope(
          diff.updated.map((item) => this.cloneManagedEntitySummary(item)),
          { requireKnownBot: true },
        ),
        removedIds: [...diff.removedIds],
        orderedIds: [...diff.orderedIds],
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId,
          baseVersion,
          expectedNextVersion,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read managed entities published diff',
      );
      return null;
    }
  }

  private scheduleManagedEntitiesPublishedSnapshotRebuild(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): void {
    if (
      !this.managedEntitiesPublishedSnapshotWriteEnabled ||
      !this.supportsManagedEntitiesPublishedSnapshot(entityType) ||
      typeof this.chatContextCache.setManagedEntitiesPublishedSnapshot !== 'function'
    ) {
      return;
    }

    const key = this.buildManagedEntitiesPublishedSnapshotRunKey(userId, entityType);
    if (this.managedEntitiesPublishedSnapshotRuns.has(key)) {
      return;
    }

    const pending = this.rebuildManagedEntitiesPublishedSnapshot(userId, entityType)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            entityType,
            userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed entities published snapshot rebuild failed',
        );
      })
      .finally(() => {
        if (this.managedEntitiesPublishedSnapshotRuns.get(key) === pending) {
          this.managedEntitiesPublishedSnapshotRuns.delete(key);
        }
      });

    this.managedEntitiesPublishedSnapshotRuns.set(key, pending);
  }

  private async upsertManagedEntitiesPublishedSnapshotItem(
    userId: string,
    summary: ChatSummary,
  ): Promise<void> {
    if (
      !this.supportsManagedEntitiesPublishedSnapshot(summary.entityType) ||
      typeof this.chatContextCache.upsertManagedEntityPublishedSnapshot !== 'function'
    ) {
      return;
    }

    await this.chatContextCache.upsertManagedEntityPublishedSnapshot(
      userId,
      this.cloneManagedEntitySummary(summary),
      MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
    );
  }

  private scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chats: readonly ChatSummary[],
  ): void {
    if (
      !this.managedEntitiesPublishedSnapshotWriteEnabled ||
      typeof this.chatContextCache.getManagedEntitiesPublishedSnapshot !== 'function' ||
      chats.length === 0
    ) {
      return;
    }

    if (entityType === 'all') {
      const chatItems = chats.filter((chat) => chat.entityType === 'chat');
      if (chatItems.length > 0) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
          userId,
          'chat',
          chatItems,
        );
      }

      const channelItems = chats.filter((chat) => chat.entityType === 'channel');
      if (channelItems.length > 0) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
          userId,
          'channel',
          channelItems,
        );
      }

      return;
    }

    const bootstrapChatIds = Array.from(
      new Set(
        chats
          .filter((chat) => chat.entityType === entityType)
          .map((chat) => chat.id)
          .filter((chatId) => chatId.trim().length > 0),
      ),
    );
    if (bootstrapChatIds.length === 0) {
      return;
    }

    void this.chatContextCache
      .getManagedEntitiesPublishedSnapshot(userId, entityType)
      .then((snapshot) => {
        const snapshotIds = new Set(snapshot?.items.map((item) => item.id) ?? []);
        if (bootstrapChatIds.every((chatId) => snapshotIds.has(chatId))) {
          return;
        }

        this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            entityType,
            userId,
            chatIds: bootstrapChatIds,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed entities published snapshot bootstrap coverage check failed',
        );
      });
  }

  private async loadRecentBotAddedBootstrapRows(userId: string): Promise<
    Array<{
      chat_id: string | null;
      chat_title: string | null;
      is_channel: string | null;
      user_scoped: boolean;
      last_event_at: Date | string | null;
      source: 'activity';
    }>
  > {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return [];
    }

    const managedEntitiesReadPrisma = this.getManagedEntitiesReadPrisma();
    const lookbackFrom = new Date(Date.now() - MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS);
    const userScopedRows = await managedEntitiesReadPrisma.$queryRaw<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        last_event_at: Date | string | null;
      }>
    >`
      SELECT
        chat_id,
        chat_title,
        CASE entity_type
          WHEN 'CHANNEL' THEN 'true'
          ELSE 'false'
        END AS is_channel,
        last_event_at
      FROM managed_entity_local_activities
      WHERE user_id = ${normalizedUserId}
        AND source_event_type = 'bot_added'
        AND last_event_at >= ${lookbackFrom}
      ORDER BY last_event_at DESC
      LIMIT ${RECENT_BOT_ADDED_USER_SCOPED_WEBHOOK_SCAN_LIMIT}
    `;
    const globalRows = await managedEntitiesReadPrisma.$queryRaw<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        last_event_at: Date | string | null;
      }>
    >`
      SELECT
        recent_rows.chat_id,
        recent_rows.chat_title,
        recent_rows.is_channel,
        recent_rows.last_event_at
      FROM (
        SELECT DISTINCT ON (chat_id)
          chat_id,
          chat_title,
          CASE entity_type
            WHEN 'CHANNEL' THEN 'true'
            ELSE 'false'
          END AS is_channel,
          last_event_at
        FROM managed_entity_local_activities
        WHERE source_event_type = 'bot_added'
        ORDER BY chat_id, last_event_at DESC
      ) AS recent_rows
      ORDER BY recent_rows.last_event_at DESC
      LIMIT ${RECENT_BOT_ADDED_WEBHOOK_SCAN_LIMIT}
    `;

    const mergedRows: Array<{
      chat_id: string | null;
      chat_title: string | null;
      is_channel: string | null;
      user_scoped: boolean;
      last_event_at: Date | string | null;
      source: 'activity';
    }> = [];
    const seen = new Set<string>();

    for (const row of [
      ...(Array.isArray(userScopedRows) ? userScopedRows : []).map((item) => ({
        ...item,
        user_scoped: true,
        source: 'activity' as const,
      })),
      ...(Array.isArray(globalRows) ? globalRows : []).map((item) => ({
        ...item,
        user_scoped: false,
        source: 'activity' as const,
      })),
    ]) {
      const chatId = this.readTrimmedString(row.chat_id);
      if (!chatId || seen.has(chatId)) {
        continue;
      }

      seen.add(chatId);
      mergedRows.push(row);
    }

    return mergedRows;
  }

  private async rebuildManagedEntitiesPublishedSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<void> {
    if (
      !this.managedEntitiesPublishedSnapshotWriteEnabled ||
      !this.supportsManagedEntitiesPublishedSnapshot(entityType) ||
      typeof this.chatContextCache.getManagedEntitiesPublishedSnapshot !== 'function' ||
      typeof this.chatContextCache.setManagedEntitiesPublishedSnapshot !== 'function'
    ) {
      return;
    }

    for (
      let attempt = 1;
      attempt <= MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_REBUILD_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const currentSnapshot = await this.chatContextCache.getManagedEntitiesPublishedSnapshot(
        userId,
        entityType,
      );
      const allowlist = await this.listChatsFromAllowlistUncached(userId, entityType, {
        allowLastSuccessFallback: false,
      });
      const edgeItems = await this.listManagedEntitiesFromFreshAccessEdges(
        userId,
        entityType,
        new Set(allowlist.map((item) => item.id)),
      );
      const user: AuthUser = {
        userId,
        username: null,
        displayName: null,
        chatTitle: null,
      };
      const revalidated = mergeManagedEntityGroups(
        await this.revalidateCachedManagedEntities(user, allowlist),
        edgeItems,
      );
      const items = await this.attachManagedEntityBotAssignments(
        await this.hydrateManagedEntities(revalidated),
      );
      const lastSyncedAt =
        (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(userId, entityType)) ?? null;
      const itemsHash = buildManagedEntitiesPublishedSnapshotHash(items, lastSyncedAt);
      const nextSnapshot: ManagedEntitiesPublishedSnapshot =
        currentSnapshot &&
        currentSnapshot.itemsHash === itemsHash &&
        currentSnapshot.itemCount === items.length &&
        currentSnapshot.lastSyncedAt === lastSyncedAt
          ? {
              ...currentSnapshot,
              items: items.map((item) => this.cloneManagedEntitySummary(item)),
            }
          : {
              version: randomUUID(),
              builtAt: new Date().toISOString(),
              lastSyncedAt,
              itemCount: items.length,
              itemsHash,
              items: items.map((item) => this.cloneManagedEntitySummary(item)),
            };

      const committed = await this.chatContextCache.setManagedEntitiesPublishedSnapshot(
        userId,
        entityType,
        nextSnapshot,
        MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
        { expectedVersion: currentSnapshot?.version ?? null },
      );
      if (!committed) {
        if (attempt === MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_REBUILD_MAX_ATTEMPTS) {
          this.logger.warn(
            { entityType, userId, attempts: attempt },
            'Managed entities published snapshot rebuild lost repeated write races',
          );
        }
        continue;
      }

      const nextDiff = buildManagedEntitiesPublishedSnapshotDiff(currentSnapshot, nextSnapshot);
      if (
        nextDiff &&
        this.managedEntitiesPublishedDiffWriteEnabled &&
        typeof this.chatContextCache.setManagedEntitiesPublishedDiff === 'function'
      ) {
        try {
          await this.chatContextCache.setManagedEntitiesPublishedDiff(
            userId,
            entityType,
            nextDiff.baseVersion,
            nextDiff,
            MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              entityType,
              userId,
              baseVersion: nextDiff.baseVersion,
              nextVersion: nextDiff.nextVersion,
              err: error instanceof Error ? error.message : String(error),
            },
            'Managed entities published diff write failed',
          );
        }
      }
      return;
    }
  }

  private async mergeManagedEntitiesPublishedSnapshotWithLightweightBootstrap(
    items: readonly ChatSummary[],
    bootstrap: {
      recentBotAdded: ChatSummary[];
    },
  ): Promise<ChatSummary[]> {
    const snapshotItems = await this.hydrateManagedEntities(
      items.map((item) => this.cloneManagedEntitySummary(item)),
    );
    const snapshotIds = new Set(items.map((item) => item.id));
    const recentBotAdded = bootstrap.recentBotAdded.filter((chat) => !snapshotIds.has(chat.id));
    const bootstrapCandidates = mergeManagedEntityGroups(recentBotAdded);
    if (bootstrapCandidates.length === 0) {
      return snapshotItems;
    }

    const hydratedBootstrap = await this.attachManagedEntityBotAssignments(
      await this.hydrateManagedEntities(bootstrapCandidates),
    );
    const hydratedById = new Map(hydratedBootstrap.map((item) => [item.id, item]));

    return this.mergeManagedEntitiesWithLightweightBootstrap(snapshotItems, {
      recentBotAdded: recentBotAdded.map((chat) => hydratedById.get(chat.id) ?? chat),
    });
  }

  private async scheduleManagedEntitiesRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      allowRecoveryWindowRun?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    const refreshKey = [user.userId, entityType, 'remote', 'full', 'background'].join(':');
    const refreshState = await this.prepareManagedEntitiesRemoteFullRefreshState(
      user.userId,
      entityType,
      options,
    );
    if (refreshState.backoffActive || refreshState.complete) {
      return refreshState;
    }

    const existing = this.managedEntitiesBackgroundRefreshRuns.get(refreshKey);

    if (!existing) {
      if (!(await this.enqueueManagedEntitiesRemoteFullRefresh(user.userId, entityType, options))) {
        const pending = this.runManagedEntitiesRemoteFullRefreshUntilSettled(
          user,
          entityType,
          options,
        )
          .catch((error: unknown) => {
            this.logger.warn(
              {
                entityType,
                userId: user.userId,
                err: error instanceof Error ? error.message : String(error),
              },
              'Managed entities background refresh failed',
            );
          })
          .finally(() => {
            if (this.managedEntitiesBackgroundRefreshRuns.get(refreshKey) === pending) {
              this.managedEntitiesBackgroundRefreshRuns.delete(refreshKey);
            }
          });
        this.managedEntitiesBackgroundRefreshRuns.set(refreshKey, pending);
      }
    }

    return refreshState;
  }

  private async scheduleManagedEntitiesBoundedRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    const refreshState = await this.prepareManagedEntitiesRemoteFullRefreshState(
      user.userId,
      entityType,
      {
        bypassRemoteCache: options.bypassRemoteCache === true,
        resetRefreshCursor: options.resetRefreshCursor === true,
      },
    );
    if (refreshState.backoffActive || refreshState.complete) {
      return refreshState;
    }

    const refreshKey = [user.userId, entityType, 'local', 'bounded', 'background'].join(':');
    if (!this.managedEntitiesBackgroundRefreshRuns.has(refreshKey)) {
      if (!(await this.enqueueManagedEntitiesRemoteFullRefresh(user.userId, entityType, options))) {
        const pending = this.runManagedEntitiesBoundedRefreshUntilSettled(user, entityType, options)
          .catch((error: unknown) => {
            this.logger.warn(
              {
                entityType,
                userId: user.userId,
                err: error instanceof Error ? error.message : String(error),
              },
              'Managed entities bounded background refresh failed',
            );
          })
          .finally(() => {
            if (this.managedEntitiesBackgroundRefreshRuns.get(refreshKey) === pending) {
              this.managedEntitiesBackgroundRefreshRuns.delete(refreshKey);
            }
          });
        this.managedEntitiesBackgroundRefreshRuns.set(refreshKey, pending);
      }
    }

    return refreshState;
  }

  private async runManagedEntitiesBoundedRefreshUntilSettled(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<void> {
    let nextOptions = {
      ...options,
    };

    while (true) {
      const outcome = await this.runManagedEntitiesBoundedRefreshJob(user, entityType, nextOptions);
      if (!outcome) {
        return;
      }

      nextOptions = {
        bypassRemoteCache: false,
        resetRefreshCursor: false,
      };
      await this.sleep(Math.max(0, outcome.continueAfterMs));
    }
  }

  private async runManagedEntitiesRemoteFullRefreshUntilSettled(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      allowRecoveryWindowRun?: boolean;
    } = {},
  ): Promise<void> {
    const allowRecoveryWindowRun = this.shouldAllowManagedEntitiesRecoveryWindowRun(options);
    let nextOptions = {
      ...options,
      allowRecoveryWindowRun,
    };

    while (true) {
      const outcome = await this.runManagedEntitiesRemoteFullRefresh(user, entityType, nextOptions);
      if (!outcome) {
        return;
      }

      nextOptions = {
        bypassRemoteCache: false,
        resetRefreshCursor: false,
        allowRecoveryWindowRun,
      };
      await this.sleep(Math.max(0, outcome.continueAfterMs));
    }
  }

  async processManagedEntitiesRefreshJob(
    job: AdminManagedEntitiesRefreshJob,
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    return this.managedEntitiesRuntime.processManagedEntitiesRefreshJob(job);
  }

  runManagedEntitiesBoundedRefreshForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    return this.managedEntitiesRuntime.runManagedEntitiesBoundedRefreshForManagedEntities(
      user,
      entityType,
      options,
    );
  }

  runManagedEntitiesRemoteFullRefreshForManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    return this.managedEntitiesRuntime.runManagedEntitiesRemoteFullRefreshForManagedEntities(
      user,
      entityType,
      options,
    );
  }

  private buildManagedEntitiesRefreshJobId(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `managed-entities-refresh__${entityType}__${userId}`;
  }
  private buildManagedEntitiesRefreshJobData(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    },
    existingData?: Partial<AdminManagedEntitiesRefreshJob> | null,
  ): AdminManagedEntitiesRefreshJob {
    return {
      userId,
      entityType,
      bypassRemoteCache:
        existingData?.bypassRemoteCache === true || options.bypassRemoteCache === true,
      resetRefreshCursor:
        existingData?.resetRefreshCursor === true || options.resetRefreshCursor === true,
      createdAt: new Date().toISOString(),
    };
  }
  private buildManagedEntitiesRefreshJobPriority(
    entityType: ManagedEntityTypeFilter,
    jobData: AdminManagedEntitiesRefreshJob,
  ): number {
    if (jobData.bypassRemoteCache) {
      return 1;
    }

    if (jobData.resetRefreshCursor) {
      return entityType === 'chat' ? 2 : 3;
    }

    return entityType === 'chat' ? 10 : 20;
  }

  private async enqueueManagedEntitiesRemoteFullRefresh(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<boolean> {
    if (!this.adminManagedEntitiesRefreshQueue) {
      return false;
    }

    const jobId = this.buildManagedEntitiesRefreshJobId(userId, entityType);

    try {
      const existing = await this.adminManagedEntitiesRefreshQueue.getJob(jobId);
      const desiredJobData = this.buildManagedEntitiesRefreshJobData(
        userId,
        entityType,
        options,
        (existing?.data as Partial<AdminManagedEntitiesRefreshJob> | undefined) ?? null,
      );
      const desiredPriority = this.buildManagedEntitiesRefreshJobPriority(
        entityType,
        desiredJobData,
      );
      if (existing) {
        const state = await existing.getState();
        const existingPriority =
          typeof existing.opts.priority === 'number'
            ? existing.opts.priority
            : Number.MAX_SAFE_INTEGER;
        const shouldPromoteWaitingJob =
          (state === 'waiting' || state === 'delayed') &&
          (desiredPriority < existingPriority ||
            existing.data?.bypassRemoteCache !== desiredJobData.bypassRemoteCache ||
            existing.data?.resetRefreshCursor !== desiredJobData.resetRefreshCursor);
        if (state !== 'failed' && state !== 'completed' && !shouldPromoteWaitingJob) {
          return true;
        }

        await existing.remove();
      }

      await this.adminManagedEntitiesRefreshQueue.add('refresh-managed-entities', desiredJobData, {
        jobId,
        priority: desiredPriority,
        delay: resolveAdminManagedEntitiesRefreshJitterMs(jobId, 'enqueue'),
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('job') && message.toLowerCase().includes('exists')) {
        return true;
      }

      this.logger.warn(
        {
          userId,
          entityType,
          err: message,
        },
        'Failed to enqueue managed entities background refresh',
      );
      return false;
    }
  }

  private async prepareManagedEntitiesRemoteFullRefreshState(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      allowRecoveryWindowRun?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    let cursor: number | null = null;
    try {
      cursor =
        (await this.chatContextCache.getManagedEntitiesRefreshCursor?.(userId, entityType)) ?? null;
    } catch {
      cursor = null;
    }

    const backgroundPauseDecision = this.peekManagedEntitiesBackgroundRefreshPauseDecision(
      'schedule',
      this.buildManagedEntitiesBackgroundGovernorOptions(options),
    );
    if (backgroundPauseDecision) {
      const pausedCursor = cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE ? null : cursor;
      const presentation = await this.loadManagedEntitiesRefreshPresentationData(
        userId,
        entityType,
      );
      return createManagedEntitiesRefreshState(
        pausedCursor,
        true,
        backgroundPauseDecision.retryAfterMs,
        presentation,
      );
    }

    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(userId, entityType);
    const backoffActive = await this.isManagedEntitiesRefreshBackoffActive(
      userId,
      entityType,
      refreshCooldownKey,
    );
    if (backoffActive) {
      return this.readManagedEntitiesRefreshState(userId, entityType, {
        backoffActiveOverride: true,
      });
    }

    if (
      options.resetRefreshCursor !== true &&
      options.bypassRemoteCache === true &&
      (cursor === null || cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE)
    ) {
      const freshness = await this.readManagedEntitiesLastSyncFreshness(userId, entityType);
      if (
        typeof freshness.ageMs === 'number' &&
        freshness.ageMs >= 0 &&
        freshness.ageMs < MANAGED_ENTITIES_MANUAL_REFRESH_RECENT_SYNC_WINDOW_MS
      ) {
        const presentation = await this.loadManagedEntitiesRefreshPresentationData(
          userId,
          entityType,
        );
        return createManagedEntitiesRefreshState(MANAGED_ENTITIES_REFRESH_CURSOR_DONE, false, 0, {
          totalCandidates: presentation.totalCandidates,
          lastSyncedAt: freshness.lastSyncedAt ?? presentation.lastSyncedAt,
        });
      }
    }

    if (
      options.resetRefreshCursor !== true &&
      options.bypassRemoteCache !== true &&
      (cursor === null || cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE)
    ) {
      const freshness = await this.readManagedEntitiesLastSyncFreshness(userId, entityType);
      if (freshness.fresh) {
        const presentation = await this.loadManagedEntitiesRefreshPresentationData(
          userId,
          entityType,
        );
        return createManagedEntitiesRefreshState(MANAGED_ENTITIES_REFRESH_CURSOR_DONE, false, 0, {
          totalCandidates: presentation.totalCandidates,
          lastSyncedAt: freshness.lastSyncedAt ?? presentation.lastSyncedAt,
        });
      }
    }

    if (
      options.resetRefreshCursor === true ||
      cursor === null ||
      cursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE
    ) {
      cursor = 0;
      await this.chatContextCache.setManagedEntitiesRefreshCursor?.(
        userId,
        entityType,
        cursor,
        MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC,
      );
    }

    return createManagedEntitiesRefreshState(cursor, false);
  }

  private async runManagedEntitiesRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
      allowRecoveryWindowRun?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    const backgroundPauseDecision = await this.resolveManagedEntitiesBackgroundRefreshPauseDecision(
      'job',
      this.buildManagedEntitiesBackgroundGovernorOptions(options),
    );
    if (backgroundPauseDecision) {
      return {
        continueAfterMs: backgroundPauseDecision.retryAfterMs,
      };
    }

    const result = await this.discoverManagedEntities(user, entityType, {
      respectCooldown: false,
      fullScan: true,
      includeRefreshState: true,
      bypassRemoteCache: options.bypassRemoteCache === true,
      resetRefreshCursor: options.resetRefreshCursor === true,
    });
    const refresh = result.refresh;
    if (!refresh || refresh.backoffActive) {
      return null;
    }

    if (refresh.complete) {
      await this.repairManagedEntitiesAllowlistAfterFullRefresh(
        user.userId,
        entityType,
        result.items,
        result.fullScanCandidateIds,
      );
      await this.rebuildManagedEntitiesPublishedSnapshot(user.userId, entityType);
      return null;
    }

    this.scheduleManagedEntitiesPublishedSnapshotRebuild(user.userId, entityType);
    return {
      continueAfterMs: Math.max(
        0,
        refresh.nextPollAfterMs ?? MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS,
      ),
    };
  }

  private async runManagedEntitiesBoundedRefreshJob(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      bypassRemoteCache?: boolean;
      resetRefreshCursor?: boolean;
    } = {},
  ): Promise<ManagedEntitiesRefreshJobOutcome> {
    const backgroundPauseDecision = await this.resolveManagedEntitiesBackgroundRefreshPauseDecision(
      'job',
      this.buildManagedEntitiesBackgroundGovernorOptions(options),
    );
    if (backgroundPauseDecision) {
      return {
        continueAfterMs: backgroundPauseDecision.retryAfterMs,
      };
    }

    if (options.resetRefreshCursor === true) {
      await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
    }

    const result = await this.discoverManagedEntitiesFromLocalCatalog(user, entityType, {
      respectCooldown: false,
      fullScan: true,
      includeRefreshState: true,
    });
    const refresh = result.refresh;
    if (!refresh || refresh.backoffActive) {
      return null;
    }

    if (refresh.complete) {
      await this.rebuildManagedEntitiesPublishedSnapshot(user.userId, entityType);
      return null;
    }

    if (result.items.length > 0) {
      this.scheduleManagedEntitiesPublishedSnapshotRebuild(user.userId, entityType);
    }

    return {
      continueAfterMs: Math.max(
        0,
        refresh.nextPollAfterMs ?? MANAGED_ENTITIES_REFRESH_NEXT_POLL_AFTER_MS,
      ),
    };
  }

  private mergeManagedEntitiesWithLightweightBootstrap(
    items: readonly ChatSummary[],
    bootstrap: {
      recentBotAdded: ChatSummary[];
    },
  ): ChatSummary[] {
    return mergeManagedEntityGroups(bootstrap.recentBotAdded, [...items]);
  }

  private async loadManagedEntitiesLightweightBootstrap(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: { adminCheckLimit?: number } = {},
  ): Promise<{
    recentBotAdded: ChatSummary[];
  }> {
    const recentBotAddedPromise = this.bootstrapRecentBotAddedEntities(user, entityType, {
      adminCheckLimit: options.adminCheckLimit,
    });

    const [recentBotAdded] = await Promise.all([
      this.awaitManagedEntitiesResponseValueWithinBudget(recentBotAddedPromise, {
        fallback: [],
        budgetMs: MANAGED_ENTITIES_LIGHTWEIGHT_RECENT_BOOTSTRAP_RESPONSE_BUDGET_MS,
        timeoutMessage:
          'Detached recent bot_added bootstrap from lightweight managed entities response after response budget exceeded',
        failureMessage:
          'Recent bot_added bootstrap failed during lightweight managed entities response',
        logData: {
          entityType,
          userId: user.userId,
        },
      }),
    ]);

    return {
      recentBotAdded,
    };
  }

  private awaitManagedEntitiesResponseValueWithinBudget<T>(
    promise: Promise<T>,
    options: {
      fallback: T;
      budgetMs: number;
      timeoutMessage: string;
      failureMessage: string;
      logData: Record<string, unknown>;
    },
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.logger.debug(
          {
            ...options.logData,
            budgetMs: options.budgetMs,
          },
          options.timeoutMessage,
        );
        finish(options.fallback);
      }, options.budgetMs);

      void promise.then(
        (value) => {
          finish(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }

          this.logger.warn(
            {
              ...options.logData,
              err: error instanceof Error ? error.message : String(error),
            },
            options.failureMessage,
          );
          finish(options.fallback);
        },
      );
    });
  }

  private buildManagedEntitiesResponseWarmupKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:response-warmup`;
  }

  private buildManagedEntitiesAllowlistWarmupKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}:allowlist-warmup`;
  }

  private buildManagedEntitiesRuntimeChatScopeFilter(): Prisma.ChatWhereInput | null {
    const runtimeBotIds = [...this.managedEntitiesRuntimeBotIds];
    if (runtimeBotIds.length === 0) {
      return null;
    }

    const inRuntimeScope = { in: runtimeBotIds };
    return {
      OR: [
        { primaryBotId: inRuntimeScope },
        { botId: inRuntimeScope },
        { botMemberships: { some: { botId: inRuntimeScope } } },
        {
          primaryBotId: null,
          botId: null,
          botMemberships: { none: {} },
        },
      ],
    };
  }

  private filterManagedEntitiesToRuntimeScope(
    chats: readonly ChatSummary[],
    options: {
      requireKnownBot?: boolean;
    } = {},
  ): ChatSummary[] {
    if (this.managedEntitiesRuntimeBotIds.size === 0) {
      return [...chats];
    }

    return chats.filter((chat) => this.isManagedEntityInRuntimeScope(chat, options));
  }

  private isManagedEntityInRuntimeScope(
    chat: Pick<ChatSummary, 'primaryBotId' | 'assignedBots'>,
    options: {
      requireKnownBot?: boolean;
    } = {},
  ): boolean {
    if (this.managedEntitiesRuntimeBotIds.size === 0) {
      return true;
    }

    const primaryBotId = this.normalizeRuntimeManagedEntityBotId(chat.primaryBotId);
    if (primaryBotId && this.managedEntitiesRuntimeBotIds.has(primaryBotId)) {
      return true;
    }

    const assignedBotIds = (chat.assignedBots ?? [])
      .map((bot) => this.normalizeRuntimeManagedEntityBotId(bot.botId))
      .filter((botId): botId is string => Boolean(botId));
    if (assignedBotIds.length > 0) {
      return assignedBotIds.some((botId) => this.managedEntitiesRuntimeBotIds.has(botId));
    }

    if (primaryBotId) {
      return false;
    }

    return options.requireKnownBot === true ? false : true;
  }

  private normalizeRuntimeManagedEntityBotId(botId: string | null | undefined): string | null {
    const configuredBot =
      typeof this.maxBotRegistry?.getBotById === 'function'
        ? this.maxBotRegistry.getBotById(botId)
        : null;
    return configuredBot?.id ?? this.readTrimmedString(botId) ?? null;
  }

  private isManagedEntityRuntimeBotId(botId: string | null | undefined): boolean {
    const normalizedBotId = this.normalizeRuntimeManagedEntityBotId(botId);
    if (!normalizedBotId) {
      return false;
    }

    const configuredBot =
      typeof this.maxBotRegistry?.getBotById === 'function'
        ? this.maxBotRegistry.getBotById(normalizedBotId)
        : null;
    if (!configuredBot) {
      return true;
    }

    return this.managedEntitiesRuntimeBotIds.size === 0
      ? true
      : this.managedEntitiesRuntimeBotIds.has(configuredBot.id);
  }

  private normalizeRuntimeManagedEntityBotIds(
    botIds: ReadonlyArray<string | null | undefined>,
  ): string[] {
    return Array.from(
      new Set(
        botIds
          .map((botId) => this.normalizeRuntimeManagedEntityBotId(botId))
          .filter(
            (botId): botId is string => Boolean(botId) && this.isManagedEntityRuntimeBotId(botId),
          ),
      ),
    );
  }

  private resolveManagedEntityDiscoveryBotIds(
    candidate: Pick<MaxBotChat, 'botId' | 'botIds'>,
  ): string[] {
    return this.normalizeRuntimeManagedEntityBotIds([candidate.botId, ...(candidate.botIds ?? [])]);
  }

  private resolveManagedEntityAccessRepairBotIds(chat: ChatSummary): string[] {
    const explicitBotIds = Array.from(
      new Set(
        [
          this.normalizeRuntimeManagedEntityBotId(chat.primaryBotId),
          ...(chat.assignedBots ?? []).map((bot) =>
            this.normalizeRuntimeManagedEntityBotId(bot.botId),
          ),
        ].filter(
          (botId): botId is string => Boolean(botId) && this.isManagedEntityRuntimeBotId(botId),
        ),
      ),
    );
    if (explicitBotIds.length > 0) {
      return explicitBotIds;
    }

    return Array.from(
      new Set(
        [
          this.normalizeManagedEntityAccessBotId(null),
          ...[...this.managedEntitiesRuntimeBotIds].map((botId) =>
            this.normalizeRuntimeManagedEntityBotId(botId),
          ),
        ].filter((botId): botId is string => Boolean(botId)),
      ),
    );
  }

  private cloneManagedEntitySummary(chat: ChatSummary): ChatSummary {
    return cloneManagedEntitySummarySnapshotValue(chat);
  }

  private async attachManagedEntityFavoriteTypes(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (items.length === 0) {
      return [];
    }

    const rows = await this.prisma.managedEntityFavorite.findMany({
      where: {
        userId,
        chatId: {
          in: Array.from(new Set(items.map((item) => item.id))),
        },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        chatId: true,
        entityType: true,
        favoriteType: true,
      },
    });
    const favoriteTypesByKey = new Map<string, ManagedEntityFavoriteType[]>();
    for (const row of rows) {
      const favoriteType = CONTRACT_FAVORITE_TYPE_BY_PRISMA[row.favoriteType];
      const key = `${fromPrismaEntityType(row.entityType)}:${row.chatId}`;
      const current = favoriteTypesByKey.get(key) ?? [];
      if (!current.includes(favoriteType)) {
        current.push(favoriteType);
      }
      favoriteTypesByKey.set(key, current);
    }

    return items.map((item) => {
      const favoriteTypes = favoriteTypesByKey.get(`${item.entityType}:${item.id}`) ?? [];
      const next: ChatSummary = { ...item };
      if (favoriteTypes.length > 0) {
        next.favoriteTypes = this.sortManagedEntityFavoriteTypes(favoriteTypes);
      } else {
        delete next.favoriteTypes;
      }
      return next;
    });
  }

  private async attachManagedEntityFavoriteTypesToDiff(
    userId: string,
    diff: ManagedEntitiesResponseDiff | null | undefined,
  ): Promise<ManagedEntitiesResponseDiff | null | undefined> {
    if (!diff || diff.mode !== 'patch') {
      return diff;
    }

    const [added, updated] = await Promise.all([
      this.attachManagedEntityFavoriteTypes(userId, diff.added),
      this.attachManagedEntityFavoriteTypes(userId, diff.updated),
    ]);

    return {
      ...diff,
      added,
      updated,
    };
  }

  private sortManagedEntityFavoriteTypes(
    favoriteTypes: readonly ManagedEntityFavoriteType[],
  ): ManagedEntityFavoriteType[] {
    const selected = new Set(favoriteTypes);
    return MANAGED_ENTITY_FAVORITE_TYPE_ORDER.filter((favoriteType) => selected.has(favoriteType));
  }

  private getManagedEntityAccessEdgeClient(): ManagedEntityAccessEdgeClient | null {
    const client = (this.prisma as unknown as { managedEntityAccessEdge?: unknown })
      .managedEntityAccessEdge;
    if (!client || typeof client !== 'object') {
      return null;
    }

    const candidate = client as Partial<ManagedEntityAccessEdgeClient>;
    return typeof candidate.findMany === 'function'
      ? (candidate as ManagedEntityAccessEdgeClient)
      : null;
  }

  private resolveManagedEntityAccessRole(
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner'> | null | undefined,
  ): ManagedEntityAccessRoleValue {
    if (access?.isOwner === true) {
      return 'OWNER';
    }
    if (access?.isAdmin === true) {
      return 'ADMIN';
    }
    if (access) {
      return 'MEMBER';
    }
    return 'UNKNOWN';
  }

  private normalizeManagedEntityAccessBotId(botId: string | null | undefined): string | null {
    return (
      this.normalizeRuntimeManagedEntityBotId(botId) ??
      this.maxBotRegistry?.getDefaultBot?.()?.id ??
      this.readTrimmedString(botId)
    );
  }

  private isManagedEntityAccessBotInRuntimeScope(botId: string | null | undefined): boolean {
    const normalizedBotId = this.normalizeManagedEntityAccessBotId(botId);
    if (!normalizedBotId) {
      return false;
    }
    return this.managedEntitiesRuntimeBotIds.size === 0
      ? true
      : this.managedEntitiesRuntimeBotIds.has(normalizedBotId);
  }

  private async upsertManagedEntityAccessEdge(params: {
    chatId: string;
    userId: string;
    botId: string | null | undefined;
    entityType: ManagedEntityType;
    state: ManagedEntityAccessStateValue;
    userRole?: ManagedEntityAccessRoleValue;
    botRole?: ManagedEntityAccessRoleValue;
    deniedReason?: string | null;
    source: string;
    expiresAt?: Date | null;
    checkedAt?: Date;
  }): Promise<void> {
    const client = this.getManagedEntityAccessEdgeClient();
    if (!client?.upsert) {
      return;
    }

    const chatId = this.readTrimmedString(params.chatId);
    const userId = this.readTrimmedString(params.userId);
    const botId = this.normalizeManagedEntityAccessBotId(params.botId);
    if (!chatId || !userId || !botId) {
      return;
    }

    const now = params.checkedAt ?? new Date();
    const expiresAt =
      params.expiresAt === undefined && params.state === 'GRANTED'
        ? new Date(now.getTime() + MANAGED_ENTITY_ACCESS_EDGE_GRANTED_TTL_MS)
        : (params.expiresAt ?? null);
    const data = {
      entityType: toPrismaEntityType(params.entityType),
      state: params.state,
      userRole: params.userRole ?? 'UNKNOWN',
      botRole: params.botRole ?? 'UNKNOWN',
      checkedAt: now,
      expiresAt,
      deniedReason: params.deniedReason ?? null,
      source: params.source,
    };

    try {
      await client.upsert({
        where: {
          chatId_userId_botId: {
            chatId,
            userId,
            botId,
          },
        },
        create: {
          chatId,
          userId,
          botId,
          ...data,
        },
        update: data,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          botId,
          state: params.state,
          source: params.source,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to upsert managed entity access edge',
      );
    }
  }

  private markManagedEntityAccessEdgesDeniedForUser(
    params: MarkManagedEntityAccessEdgesDeniedForUserParams,
  ): Promise<void> {
    return this.managedEntityAccessRuntime.markManagedEntityAccessEdgesDeniedForUser(params);
  }

  private readManagedEntitiesLastSuccessSnapshot(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): ChatSummary[] {
    return this.managedEntitiesSnapshotRuntime.readManagedEntitiesLastSuccessSnapshot(
      userId,
      entityType,
    );
  }

  private rememberManagedEntitiesLastSuccessChats(
    userId: string,
    chats: readonly ChatSummary[],
  ): void {
    return this.managedEntitiesSnapshotRuntime.rememberManagedEntitiesLastSuccessChats(
      userId,
      chats,
    );
  }

  private forgetManagedEntitiesLastSuccessChat(userId: string, chatId: string): void {
    return this.managedEntitiesSnapshotRuntime.forgetManagedEntitiesLastSuccessChat(userId, chatId);
  }

  private invalidateManagedEntitiesAllowlistCache(userId: string): void {
    return this.managedEntitiesSnapshotRuntime.invalidateManagedEntitiesAllowlistCache(userId);
  }

  private listChatsFromAllowlistWithinResponseBudget(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      source: 'default' | 'refresh';
    },
  ): Promise<ChatSummary[]> {
    const fallbackSnapshot = this.readManagedEntitiesLastSuccessSnapshot(userId, entityType);
    return this.awaitManagedEntitiesResponseValueWithinBudget(
      this.listChatsFromAllowlist(userId, entityType),
      {
        fallback: fallbackSnapshot,
        budgetMs: MANAGED_ENTITIES_ALLOWLIST_RESPONSE_BUDGET_MS,
        timeoutMessage:
          fallbackSnapshot.length > 0
            ? 'Used last successful managed entities snapshot after allowlist read exceeded response budget'
            : 'Detached managed entities allowlist read from response after response budget exceeded',
        failureMessage:
          'Managed entities allowlist read failed during user-facing managed entities response',
        logData: {
          entityType,
          fallbackItems: fallbackSnapshot.length,
          source: options.source,
          userId,
        },
      },
    );
  }

  private startManagedEntitiesResponseWarmup(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      includeRefreshState?: boolean;
    } = {},
  ): Promise<ManagedEntitiesListResult> {
    const key = this.buildManagedEntitiesResponseWarmupKey(user.userId, entityType);
    const existing = this.managedEntitiesResponseWarmupRuns.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.discoverManagedEntitiesFromLocalCatalog(user, entityType, {
      respectCooldown: false,
      fullScan: false,
      includeRefreshState: options.includeRefreshState === true,
    }).finally(() => {
      if (this.managedEntitiesResponseWarmupRuns.get(key) === pending) {
        this.managedEntitiesResponseWarmupRuns.delete(key);
      }
    });

    this.managedEntitiesResponseWarmupRuns.set(key, pending);
    return pending;
  }

  private scheduleManagedEntitiesPriorityAllowlistWarmup(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      seededChats?: readonly ChatSummary[];
    } = {},
  ): void {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    const key = this.buildManagedEntitiesAllowlistWarmupKey(user.userId, entityType);
    if (this.managedEntitiesAllowlistWarmupRuns.has(key)) {
      return;
    }

    const pending = this.runManagedEntitiesPriorityAllowlistWarmup(user, entityType, options)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            entityType,
            userId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed entities priority allowlist warmup failed',
        );
      })
      .finally(() => {
        if (this.managedEntitiesAllowlistWarmupRuns.get(key) === pending) {
          this.managedEntitiesAllowlistWarmupRuns.delete(key);
        }
      });

    this.managedEntitiesAllowlistWarmupRuns.set(key, pending);
  }

  private async runManagedEntitiesPriorityAllowlistWarmup(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      seededChats?: readonly ChatSummary[];
    } = {},
  ): Promise<void> {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    const seededCandidates = (options.seededChats ?? []).map((chat) =>
      this.toManagedEntitiesDiscoveryCandidate(chat),
    );
    const priorityCandidates = this.mergeManagedEntitiesDiscoverySnapshots(
      seededCandidates,
      await this.loadManagedEntitiesDeltaPrioritySnapshot(user, entityType),
    ).slice(0, MANAGED_ENTITIES_PRIORITY_ALLOWLIST_WARMUP_LIMIT);

    if (priorityCandidates.length === 0) {
      return;
    }

    await this.maxChatAdminRosterSyncService.scheduleDiscoverySnapshotSync(priorityCandidates);
  }

  private createManagedEntitySummary(params: {
    id: string;
    title: string;
    createdAt: string;
    entityType: ManagedEntityType;
    link?: string | null;
    avatarUrl?: string | null;
    channelOverview?: ChannelOverview | null;
    primaryBotId?: string | null;
    assignedBots?: ManagedEntityAssignedBot[];
    sharedMode?: ChatSummary['sharedMode'];
    favoriteTypes?: ManagedEntityFavoriteType[];
  }): ChatSummary {
    const assignedBots = [...(params.assignedBots ?? [])];
    return {
      id: params.id,
      title: params.title,
      createdAt: params.createdAt,
      entityType: params.entityType,
      link: params.link ?? null,
      ...(this.readTrimmedString(params.avatarUrl) ? { avatarUrl: params.avatarUrl } : {}),
      channelOverview: params.channelOverview ?? null,
      primaryBotId: this.readTrimmedString(params.primaryBotId) ?? null,
      assignedBots,
      sharedMode: params.sharedMode ?? (assignedBots.length > 1 ? 'shared-standby' : 'owned'),
      ...(params.favoriteTypes && params.favoriteTypes.length > 0
        ? { favoriteTypes: this.sortManagedEntityFavoriteTypes(params.favoriteTypes) }
        : {}),
    };
  }

  private async attachManagedEntityBotAssignments(chats: ChatSummary[]): Promise<ChatSummary[]> {
    return this.managedEntitiesRuntime.attachManagedEntityBotAssignments(chats);
  }

  private async attachManagedEntityHeaderBotAssignments(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader> {
    return this.managedEntitiesRuntime.attachManagedEntityHeaderBotAssignments(header);
  }

  private mergeManagedEntitiesDiscoverySnapshots(
    ...groups: readonly ManagedEntitiesDiscoverySnapshot[]
  ): ManagedEntitiesDiscoverySnapshot {
    const mergedByChatId = new Map<string, MaxBotChat>();

    for (const group of groups) {
      for (const chat of group) {
        if (!chat.chatId) {
          continue;
        }

        const existing = mergedByChatId.get(chat.chatId);
        const mergedBotIds = Array.from(
          new Set([
            ...(existing?.botIds ?? []),
            ...(chat.botIds ?? []),
            ...(chat.botId ? [chat.botId] : []),
          ]),
        );

        if (!existing) {
          mergedByChatId.set(chat.chatId, {
            ...chat,
            botIds: mergedBotIds,
            botId: this.readTrimmedString(chat.botId) ?? mergedBotIds[0] ?? null,
          });
          continue;
        }

        mergedByChatId.set(chat.chatId, {
          ...existing,
          title: this.readTrimmedString(existing.title) ?? this.readTrimmedString(chat.title),
          lastEventTime: Math.max(existing.lastEventTime ?? 0, chat.lastEventTime ?? 0),
          entityType: existing.entityType,
          link: this.readTrimmedString(existing.link) ?? this.readTrimmedString(chat.link),
          avatarUrl:
            this.readTrimmedString(existing.avatarUrl) ?? this.readTrimmedString(chat.avatarUrl),
          botId: this.readTrimmedString(existing.botId) ?? this.readTrimmedString(chat.botId),
          botIds: mergedBotIds,
        });
      }
    }

    return [...mergedByChatId.values()];
  }

  private toManagedEntitiesDiscoveryCandidate(chat: ChatSummary): MaxBotChat {
    return {
      chatId: chat.id,
      title: chat.title,
      lastEventTime: Date.parse(chat.createdAt) || 0,
      entityType: chat.entityType,
      link: chat.link ?? null,
      avatarUrl: chat.avatarUrl ?? null,
      botId: chat.primaryBotId ?? null,
      botIds: chat.assignedBots.map((bot) => bot.botId),
    };
  }

  private async readLocalManagedEntitiesRefreshState(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: { backoffActiveOverride?: boolean } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(userId, entityType);
    const backoffActive =
      options.backoffActiveOverride ??
      (await this.isManagedEntitiesRefreshBackoffActive(userId, entityType, refreshCooldownKey));
    const nextPollAfterMs = backoffActive
      ? await this.getManagedEntitiesRefreshBackoffRemainingMs(
          userId,
          entityType,
          refreshCooldownKey,
        )
      : 0;
    const lastSyncedAt =
      (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(userId, entityType)) ?? null;

    return createManagedEntitiesRefreshState(
      backoffActive ? null : MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
      backoffActive,
      nextPollAfterMs,
      {
        totalCandidates: null,
        lastSyncedAt,
      },
    );
  }

  private async loadManagedEntitiesLocalDiscoverySnapshot(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: { limit: number },
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const normalizedUserId = user.userId.trim();
    if (!normalizedUserId) {
      return [];
    }

    const managedEntitiesReadPrisma = this.getManagedEntitiesReadPrisma();
    const limit = Math.max(1, options.limit);
    return (
      this.managedEntityCandidateSyncService ?? new ManagedEntityCandidateSyncService()
    ).loadLocalDiscoverySnapshot(managedEntitiesReadPrisma, normalizedUserId, entityType, {
      limit,
    });
  }

  private async loadManagedEntitiesDeltaPrioritySnapshot(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    let localCandidates: ManagedEntitiesDiscoverySnapshot = [];

    try {
      localCandidates = await this.loadManagedEntitiesLocalDiscoverySnapshot(user, entityType, {
        limit: MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId: user.userId,
          code:
            error instanceof Prisma.PrismaClientKnownRequestError
              ? error.code
              : ((error as { code?: string } | null)?.code ?? null),
          err: error instanceof Error ? error.message : String(error),
        },
        isPrismaKnownError(error, 'P2024')
          ? 'Skipped managed entities local priority snapshot because the Prisma pool is saturated'
          : 'Failed to load managed entities local priority snapshot',
      );
    }

    return localCandidates;
  }

  private async persistManagedEntityAccessBestEffort(params: {
    chatId: string;
    userId: string;
    title: string | null;
    entityType: ManagedEntityType;
    link?: string | null;
    avatarUrl?: string | null;
    createdAtFallback?: string | null;
    preferredBotId?: string | null;
    observedBotIds?: readonly string[] | null;
    source: 'remote_discovery' | 'local_discovery' | 'recent_bot_added_bootstrap';
    probeStartedAt: Date;
  }): Promise<ChatSummary | null> {
    if (!Number.isFinite(params.probeStartedAt.getTime())) {
      return null;
    }

    try {
      const persistedChat = await this.upsertUserChatAccess(
        params.chatId,
        params.userId,
        params.title,
        params.entityType,
        {
          updateEntityType: true,
          preferredBotId: params.preferredBotId ?? null,
          observedBotIds: params.observedBotIds ?? [],
          titleUpdateMode:
            params.source === 'recent_bot_added_bootstrap' ? 'fallback_only' : 'always',
          accessProbeStartedAt: params.probeStartedAt,
        },
      );
      if (!persistedChat) {
        return null;
      }

      const summary = this.createManagedEntitySummary({
        id: persistedChat.id,
        title: persistedChat.title,
        createdAt: persistedChat.createdAt.toISOString(),
        entityType: fromPrismaEntityType(persistedChat.entityType),
        link: params.link ?? null,
        avatarUrl: params.avatarUrl ?? null,
        primaryBotId:
          this.readTrimmedString(persistedChat.primaryBotId ?? persistedChat.botId) ?? null,
      });
      const cacheApplied = await this.chatContextCache.applyAdminAccessEpochMutation({
        chatId: summary.id,
        userId: params.userId,
        state: 'granted',
        eventAt: params.probeStartedAt,
        publishedSummary: summary,
        publishedSnapshotTtlSec: MANAGED_ENTITIES_PUBLISHED_SNAPSHOT_TTL_SEC,
        recentBootstrapSummary:
          params.source === 'recent_bot_added_bootstrap' ? summary : undefined,
      });
      if (!cacheApplied) {
        return null;
      }

      this.rememberManagedEntitiesLastSuccessChats(params.userId, [summary]);

      if (params.source === 'recent_bot_added_bootstrap') {
        this.scheduleAdminAccessValidationRosterSync(summary.id, summary.entityType);
      }

      return summary;
    } catch (error: unknown) {
      if (!isPrismaKnownError(error, 'P2024')) {
        throw error;
      }

      const resolvedBotId =
        this.maxBotRegistry?.getBotById(params.preferredBotId)?.id ??
        (params.observedBotIds ?? [])
          .map((botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null)
          .find((botId): botId is string => Boolean(botId)) ??
        null;
      if (resolvedBotId) {
        this.maxBotLinkService?.rememberChatBotBinding?.(params.chatId, resolvedBotId);
      }

      this.logger.warn(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          userId: params.userId,
          source: params.source,
          code:
            error instanceof Prisma.PrismaClientKnownRequestError
              ? error.code
              : ((error as { code?: string } | null)?.code ?? null),
          err: error instanceof Error ? error.message : String(error),
        },
        'Using transient managed entity summary because the Prisma pool is saturated',
      );

      const summary = this.createManagedEntitySummary({
        id: params.chatId,
        title:
          resolvePresentableManagedEntityTitle(params.chatId, params.title, null, null) ??
          params.chatId,
        createdAt: this.readTrimmedString(params.createdAtFallback) ?? new Date().toISOString(),
        entityType: params.entityType,
        link: params.link ?? null,
        avatarUrl: params.avatarUrl ?? null,
        primaryBotId: resolvedBotId,
      });
      this.rememberManagedEntitiesLastSuccessChats(params.userId, [summary]);

      return summary;
    }
  }

  private async collectManagedEntitiesForMassAction(
    user: AuthUser,
    entityType: ManagedEntityType,
    options: {
      discoveryMode?: 'full' | 'cached-first';
    } = {},
  ): Promise<ChatSummary[]> {
    if (options.discoveryMode === 'cached-first') {
      return this.collectManagedEntitiesForCachedMassAction(user, entityType);
    }

    try {
      await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType,
          userId: user.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reset managed entities refresh cursor before mass action scan',
      );
    }

    const collected = new Map<string, ChatSummary>();
    const cached = await this.revalidateCachedManagedEntities(
      user,
      await this.listChatsFromAllowlist(user.userId, entityType),
    );
    for (const item of cached) {
      collected.set(item.id, item);
    }
    let refreshState: ManagedEntitiesRefreshState | null = null;
    let previousCursor: number | null | undefined = undefined;
    let attemptedPasses = 0;
    const bypassRemoteCacheOnInitialPass = collected.size === 0;

    for (let pass = 0; pass < MANAGED_ENTITIES_MASS_ACTION_FULL_SCAN_MAX_PASSES; pass += 1) {
      attemptedPasses = pass + 1;
      let result: ManagedEntitiesListResult;
      try {
        result = await this.discoverManagedEntities(user, entityType, {
          respectCooldown: false,
          fullScan: true,
          includeRefreshState: true,
          bypassRemoteCache: pass === 0 && bypassRemoteCacheOnInitialPass,
        });
      } catch (error: unknown) {
        if (collected.size > 0 && isMaxApiThrottleError(error)) {
          this.logger.warn(
            {
              entityType,
              userId: user.userId,
              cachedItems: collected.size,
              err: error instanceof Error ? error.message : String(error),
            },
            'Managed entities mass action scan hit MAX API throttle; using cached allowlist fallback',
          );
          break;
        }
        throw error;
      }
      for (const item of result.items) {
        collected.set(item.id, item);
      }

      refreshState = result.refresh;
      if (!refreshState || refreshState.complete || refreshState.backoffActive) {
        break;
      }
      if (refreshState.cursor === null || refreshState.cursor === previousCursor) {
        break;
      }

      previousCursor = refreshState.cursor;
    }

    if (refreshState && !refreshState.complete && !refreshState.backoffActive) {
      this.logger.warn(
        {
          entityType,
          userId: user.userId,
          cursor: refreshState.cursor,
          passes: attemptedPasses,
        },
        'Managed entities mass action scan stopped before completion',
      );
    }

    return [...collected.values()];
  }

  private async collectManagedEntitiesForCachedMassAction(
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ChatSummary[]> {
    const collected = new Map<string, ChatSummary>();

    const publishedSnapshot = await this.readManagedEntitiesPublishedSnapshotForResponse(
      user.userId,
      entityType,
    );
    for (const item of publishedSnapshot?.items ?? []) {
      collected.set(item.id, item);
    }

    const cached = await this.revalidateCachedManagedEntities(
      user,
      await this.listChatsFromAllowlistWithinResponseBudget(user.userId, entityType, {
        source: 'refresh',
      }),
    );
    for (const item of cached) {
      collected.set(item.id, item);
    }

    if (collected.size === 0) {
      for (const item of this.readManagedEntitiesLastSuccessSnapshot(user.userId, entityType)) {
        collected.set(item.id, item);
      }
    }

    if (this.adminManagedEntitiesRefreshQueue) {
      void this.scheduleManagedEntitiesBoundedRefresh(user, entityType).catch((error: unknown) => {
        this.logger.warn(
          {
            entityType,
            userId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule managed entities background refresh after cached mass action lookup',
        );
      });
    }

    return [...collected.values()];
  }

  private async bootstrapRecentBotAddedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: { adminCheckLimit?: number } = {},
  ): Promise<ChatSummary[]> {
    const normalizedUserId = user.userId.trim();
    if (!normalizedUserId) {
      return [];
    }
    const adminCheckLimit = Math.max(
      0,
      Math.trunc(options.adminCheckLimit ?? RECENT_BOT_ADDED_BOOTSTRAP_MAX_ADMIN_CHECKS),
    );
    if (adminCheckLimit <= 0) {
      return [];
    }

    const managedEntitiesReadPrisma = this.getManagedEntitiesReadPrisma();
    const [rows, cachedRows] = await Promise.all([
      this.loadRecentBotAddedBootstrapRows(normalizedUserId),
      this.loadRecentBotAddedBootstrapCacheRows(normalizedUserId, entityType),
    ]);
    const safeRows = this.mergeRecentBotAddedBootstrapRows(
      cachedRows,
      Array.isArray(rows) ? rows : [],
    );

    const bootstrapped: ChatSummary[] = [];
    const seen = new Set<string>();
    let attemptedAdminChecks = 0;
    const startedAtMs = Date.now();

    for (const row of safeRows) {
      const chatId = this.readTrimmedString(row.chat_id);
      if (!chatId || seen.has(chatId)) {
        continue;
      }
      seen.add(chatId);

      const hintedEntityType: ManagedEntityType = row.is_channel === 'true' ? 'channel' : 'chat';
      if (entityType !== 'all' && hintedEntityType !== entityType) {
        continue;
      }
      if (isUnsupportedManagedChat(chatId, hintedEntityType)) {
        this.managedEntityAccessRuntime.schedulePersistedChatAccessPrune(
          chatId,
          normalizedUserId,
          'bootstrap_recent_bot_added',
        );
        continue;
      }

      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs >= RECENT_BOT_ADDED_BOOTSTRAP_MAX_ELAPSED_MS) {
        this.logger.debug(
          {
            entityType,
            userId: normalizedUserId,
            attemptedAdminChecks,
            elapsedMs,
            scannedCandidates: seen.size,
          },
          'Stopped recent bot_added bootstrap before completion to keep lightweight chat discovery responsive',
        );
        break;
      }

      if (attemptedAdminChecks >= adminCheckLimit) {
        this.logger.debug(
          {
            entityType,
            userId: normalizedUserId,
            attemptedAdminChecks,
            adminCheckLimit,
            scannedCandidates: seen.size,
          },
          'Stopped recent bot_added bootstrap before completion to keep lightweight chat discovery responsive',
        );
        break;
      }

      attemptedAdminChecks += 1;
      const access = await this.resolveUserAndBotAdminAccess(chatId, normalizedUserId, {
        bypassNegativeCache: true,
        bypassPositiveCache: true,
        allowPersistedFallback: false,
        entityType: hintedEntityType,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        timeoutMs: RECENT_BOT_ADDED_BOOTSTRAP_ADMIN_TIMEOUT_MS,
      });
      if (access.status === 'unknown' || access.status === 'throttled') {
        if (row.user_scoped) {
          this.scheduleUserScopedRecentBotAddedFastLane({
            chatId,
            entityType: hintedEntityType,
            title: this.readTrimmedString(row.chat_title),
            userId: normalizedUserId,
            reason: access.status,
          });
        }
        this.logger.debug(
          {
            chatId,
            entityType,
            userId: normalizedUserId,
            attemptedAdminChecks,
            accessStatus: access.status,
          },
          'Stopped recent bot_added bootstrap after a slow admin access lookup',
        );
        break;
      }
      if (access.status !== 'granted') {
        if (row.user_scoped && access.reason === 'bot_not_admin') {
          this.scheduleUserScopedRecentBotAddedFastLane({
            chatId,
            entityType: hintedEntityType,
            title: this.readTrimmedString(row.chat_title),
            userId: normalizedUserId,
            reason: access.reason,
          });
        }
        continue;
      }
      if (!access.probeStartedAt) {
        continue;
      }

      const existing = await managedEntitiesReadPrisma.chat.findUnique({
        where: { id: chatId },
        select: {
          title: true,
        },
      });
      const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
        chatId,
        hintedEntityType,
      );
      const resolvedTitle =
        resolvePresentableManagedEntityTitle(
          chatId,
          this.readTrimmedString(row.chat_title),
          this.readTrimmedString(cachedHeader?.title),
          this.readTrimmedString(existing?.title),
        ) ??
        (row.user_scoped
          ? hintedEntityType === 'channel'
            ? `Channel ${chatId}`
            : `Chat ${chatId}`
          : null);
      if (!resolvedTitle) {
        continue;
      }
      const chat = await this.persistManagedEntityAccessBestEffort({
        chatId,
        userId: normalizedUserId,
        title: resolvedTitle,
        entityType: hintedEntityType,
        source: 'recent_bot_added_bootstrap',
        probeStartedAt: access.probeStartedAt,
      });
      if (!chat) {
        continue;
      }

      bootstrapped.push(
        row.user_scoped
          ? await this.maybeHydrateRecentBotAddedBootstrapChat(normalizedUserId, entityType, chat)
          : chat,
      );
      if (bootstrapped.length >= RECENT_BOT_ADDED_BOOTSTRAP_LIMIT) {
        break;
      }
    }

    this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
      normalizedUserId,
      entityType,
      bootstrapped,
    );

    return bootstrapped;
  }

  private async loadRecentBotAddedBootstrapCacheRows(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<
    Array<{
      chat_id: string | null;
      chat_title: string | null;
      is_channel: string | null;
      user_scoped: boolean;
      last_event_at: Date | string | null;
      source: 'cache' | 'activity';
    }>
  > {
    if (typeof this.chatContextCache.getManagedEntitiesRecentBootstrap !== 'function') {
      return [];
    }

    const normalizedUserId = userId.trim();
    const entityTypes: ManagedEntityType[] =
      entityType === 'all' ? ['chat', 'channel'] : [entityType];
    const groups = await Promise.all(
      entityTypes.map(
        (currentEntityType) =>
          this.chatContextCache.getManagedEntitiesRecentBootstrap?.(
            currentEntityType,
            normalizedUserId,
          ) ?? Promise.resolve([]),
      ),
    );

    return this.mergeRecentBotAddedBootstrapRows(
      ...groups.map((group) =>
        group
          .filter((chat) => !isUnsupportedManagedChat(chat.id, chat.entityType))
          .map((chat) => ({
            chat_id: chat.id,
            chat_title: chat.title,
            is_channel: chat.entityType === 'channel' ? 'true' : 'false',
            user_scoped:
              normalizedUserId.length > 0 &&
              Array.isArray(chat.bootstrapUserIds) &&
              chat.bootstrapUserIds.some((candidateUserId) => candidateUserId === normalizedUserId),
            last_event_at: this.readTrimmedString(chat.createdAt),
            source: 'cache' as const,
          })),
      ),
    );
  }

  private mergeRecentBotAddedBootstrapRows(
    ...groups: Array<
      Array<{
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        user_scoped: boolean;
        last_event_at: Date | string | null;
        source: 'activity' | 'cache';
      }>
    >
  ): Array<{
    chat_id: string | null;
    chat_title: string | null;
    is_channel: string | null;
    user_scoped: boolean;
    last_event_at: Date | string | null;
    source: 'activity' | 'cache';
  }> {
    const merged = new Map<
      string,
      {
        chat_id: string | null;
        chat_title: string | null;
        is_channel: string | null;
        user_scoped: boolean;
        last_event_at: Date | string | null;
        source: 'activity' | 'cache';
      }
    >();

    for (const group of groups) {
      for (const row of group) {
        const chatId = this.readTrimmedString(row.chat_id);
        if (!chatId) {
          continue;
        }

        const existing = merged.get(chatId);
        if (!existing) {
          merged.set(chatId, row);
          continue;
        }

        if (row.user_scoped && !existing.user_scoped) {
          merged.set(chatId, row);
          continue;
        }
        if (!row.user_scoped && existing.user_scoped) {
          continue;
        }
        if (
          existing.source === 'cache' &&
          row.source !== 'cache' &&
          existing.user_scoped === row.user_scoped
        ) {
          continue;
        }

        const existingEventAtMs = this.readRecentBotAddedEventTimestampMs(existing.last_event_at);
        const nextEventAtMs = this.readRecentBotAddedEventTimestampMs(row.last_event_at);
        if (
          nextEventAtMs !== null &&
          (existingEventAtMs === null || nextEventAtMs > existingEventAtMs)
        ) {
          merged.set(chatId, row);
          continue;
        }

        if (
          nextEventAtMs === existingEventAtMs &&
          this.readTrimmedString(row.chat_title) &&
          !this.readTrimmedString(existing.chat_title)
        ) {
          merged.set(chatId, row);
        }
      }
    }

    return [...merged.values()];
  }

  private async buildRecentBotAddedProvisionalChat(params: {
    row: {
      chat_id: string | null;
      chat_title: string | null;
      is_channel: string | null;
      user_scoped: boolean;
      last_event_at: Date | string | null;
      source: 'activity' | 'cache';
    };
    userId: string;
    entityType: ManagedEntityTypeFilter;
    hintedEntityType: ManagedEntityType;
    prisma: ReturnType<AdminService['getManagedEntitiesReadPrisma']>;
  }): Promise<ChatSummary | null> {
    if (!params.row.user_scoped) {
      return null;
    }

    const chatId = this.readTrimmedString(params.row.chat_id);
    if (!chatId) {
      return null;
    }

    const [existing, cachedHeader] = await Promise.all([
      params.prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          title: true,
          createdAt: true,
          primaryBotId: true,
          botId: true,
        },
      }),
      this.chatContextCache.getManagedEntityHeader?.(chatId, params.hintedEntityType) ?? null,
    ]);
    const eventAtMs = this.readRecentBotAddedEventTimestampMs(params.row.last_event_at);
    const hasPersistedBootstrapContext =
      existing !== null || this.readTrimmedString(cachedHeader?.title) !== null;
    if (
      eventAtMs === null ||
      (!hasPersistedBootstrapContext &&
        params.row.source !== 'cache' &&
        Date.now() - eventAtMs > RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS)
    ) {
      return null;
    }

    const resolvedTitle =
      resolvePresentableManagedEntityTitle(
        chatId,
        this.readTrimmedString(params.row.chat_title),
        this.readTrimmedString(cachedHeader?.title),
        this.readTrimmedString(existing?.title),
      ) ?? (params.hintedEntityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);

    const createdAtIso =
      existing?.createdAt instanceof Date
        ? existing.createdAt.toISOString()
        : new Date(eventAtMs).toISOString();
    const provisional = this.createManagedEntitySummary({
      id: chatId,
      title: resolvedTitle,
      createdAt: createdAtIso,
      entityType: params.hintedEntityType,
      primaryBotId:
        this.normalizeRuntimeManagedEntityBotId(
          this.readTrimmedString(existing?.primaryBotId) ??
            this.readTrimmedString(existing?.botId) ??
            null,
        ) ?? null,
    });
    const hydrated = await this.maybeHydrateRecentBotAddedBootstrapChat(
      params.userId,
      params.entityType,
      provisional,
    );
    this.rememberManagedEntitiesLastSuccessChats(params.userId, [hydrated]);
    return hydrated;
  }

  private readRecentBotAddedEventTimestampMs(value: Date | string | null): number | null {
    if (value instanceof Date) {
      const timestampMs = value.getTime();
      return Number.isFinite(timestampMs) ? timestampMs : null;
    }

    const normalized = this.readTrimmedString(value);
    if (!normalized) {
      return null;
    }

    const timestampMs = Date.parse(normalized);
    return Number.isFinite(timestampMs) ? timestampMs : null;
  }

  private scheduleUserScopedRecentBotAddedFastLane(params: {
    chatId: string;
    entityType: ManagedEntityType;
    title: string | null;
    userId: string;
    reason: 'unknown' | 'throttled' | 'bot_not_admin';
  }): void {
    if (!this.maxChatAdminRosterSyncService) {
      return;
    }

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId: params.chatId,
        title: params.title,
        entityType: params.entityType,
        source: 'webhook_bot_added',
        retryUntilMs: Date.now() + RECENT_BOT_ADDED_FAST_LANE_RETRY_WINDOW_MS,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId: params.chatId,
            entityType: params.entityType,
            userId: params.userId,
            reason: params.reason,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule user-scoped recent bot_added fast lane retry',
        );
      });
  }

  private async maybeHydrateRecentBotAddedBootstrapChat(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chat: ChatSummary,
  ): Promise<ChatSummary> {
    if (!isFallbackTitle(chat.id, chat.title)) {
      return chat;
    }

    const key = [userId, entityType, chat.entityType, chat.id].join(':');
    const existing = this.recentBotAddedImmediateHeaderHydrationRuns.get(key);
    const pending =
      existing ??
      this.runRecentBotAddedImmediateHeaderHydration(userId, entityType, chat)
        .catch((error: unknown) => {
          this.logger.debug(
            {
              chatId: chat.id,
              entityType: chat.entityType,
              userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Immediate recent bot_added header hydration fell back to provisional title',
          );
          return this.cloneManagedEntitySummary(chat);
        })
        .finally(() => {
          if (this.recentBotAddedImmediateHeaderHydrationRuns.get(key) === pending) {
            this.recentBotAddedImmediateHeaderHydrationRuns.delete(key);
          }
        });

    if (!existing) {
      this.recentBotAddedImmediateHeaderHydrationRuns.set(key, pending);
    }

    return this.awaitManagedEntitiesResponseValueWithinBudget(pending, {
      fallback: this.cloneManagedEntitySummary(chat),
      budgetMs: RECENT_BOT_ADDED_BOOTSTRAP_HEADER_RESPONSE_BUDGET_MS,
      timeoutMessage:
        'Detached immediate recent bot_added header hydration after response budget exceeded',
      failureMessage: 'Immediate recent bot_added header hydration failed',
      logData: {
        chatId: chat.id,
        entityType: chat.entityType,
        userId,
      },
    });
  }

  private async runRecentBotAddedImmediateHeaderHydration(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chat: ChatSummary,
  ): Promise<ChatSummary> {
    if (typeof this.maxClient.getChatSnapshot !== 'function') {
      return this.cloneManagedEntitySummary(chat);
    }

    const candidateBotIds = new Set<string>();
    const preferredBotId = this.maxBotRegistry?.getBotById(chat.primaryBotId)?.id ?? null;
    if (preferredBotId) {
      candidateBotIds.add(preferredBotId);
    }
    for (const botId of await this.resolveCandidateBotIdsForChat(chat.id, {
      includeDiscoveryFallback: true,
    })) {
      candidateBotIds.add(botId);
    }

    const botIds = [...candidateBotIds];
    const lookupOrder = botIds.length > 0 ? botIds : [null];

    for (const botId of lookupOrder) {
      try {
        const snapshot = await this.maxClient.getChatSnapshot(chat.id, {
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          timeoutMs: RECENT_BOT_ADDED_BOOTSTRAP_HEADER_TIMEOUT_MS,
          bypassCache: true,
          ...(botId ? { botId } : {}),
        });

        const resolvedTitle =
          resolvePresentableManagedEntityTitle(chat.id, snapshot.title, chat.title) ?? chat.title;
        const resolvedLink = this.readTrimmedString(snapshot.link) ?? chat.link ?? null;
        const resolvedAvatarUrl =
          this.readTrimmedString(snapshot.avatarUrl) ?? this.readTrimmedString(chat.avatarUrl);
        const hydratedSnapshot = {
          title: resolvedTitle,
          link: resolvedLink,
          participantsCount: snapshot.participantsCount,
          avatarUrl: resolvedAvatarUrl ?? null,
        };

        await this.persistManagedEntityHeaderSnapshot(chat, hydratedSnapshot);
        const hydrated = this.cloneManagedEntitySummary({
          ...chat,
          title: resolvedTitle,
          link: resolvedLink,
          ...(resolvedAvatarUrl ? { avatarUrl: resolvedAvatarUrl } : {}),
        });
        await this.upsertManagedEntitiesPublishedSnapshotItem(userId, hydrated);
        this.scheduleManagedEntitiesPublishedSnapshotRebuild(userId, entityType);

        this.rememberManagedEntitiesLastSuccessChats(userId, [hydrated]);
        return hydrated;
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          continue;
        }

        if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
          break;
        }

        this.logger.debug(
          {
            chatId: chat.id,
            entityType: chat.entityType,
            botId: botId ?? 'default',
            err: error instanceof Error ? error.message : String(error),
          },
          'Immediate recent bot_added header hydration failed for candidate bot',
        );
      }
    }

    return this.cloneManagedEntitySummary(chat);
  }

  private async revalidateCachedManagedEntities(
    user: AuthUser,
    chats: ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (chats.length === 0) {
      return chats;
    }

    const cachedAccessStates = await Promise.all(
      chats.map(async (chat) => ({
        chat,
        cachedAccess: (await this.chatContextCache.getAdminAccess?.(chat.id, user.userId)) ?? null,
      })),
    );
    const filtered: Array<ChatSummary | null> = new Array<ChatSummary | null>(chats.length).fill(
      null,
    );
    const staleDeniedChats: Array<{ chat: ChatSummary; index: number }> = [];
    const suspiciousChats: Array<{ chat: ChatSummary; index: number }> = [];

    for (const [index, entry] of cachedAccessStates.entries()) {
      if (entry.cachedAccess === 'user_denied' || entry.cachedAccess === 'bot_denied') {
        staleDeniedChats.push({
          chat: entry.chat,
          index,
        });
        continue;
      }

      if (
        entry.cachedAccess !== 'granted' &&
        this.isSuspiciousManagedEntitiesAllowlistChat(entry.chat)
      ) {
        suspiciousChats.push({
          chat: entry.chat,
          index,
        });
        continue;
      }

      filtered[index] = entry.chat;
    }

    const suspiciousChatsToRevalidate = suspiciousChats.slice(
      0,
      MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_REVALIDATION_LIMIT,
    );
    for (const candidate of suspiciousChats.slice(suspiciousChatsToRevalidate.length)) {
      filtered[candidate.index] = candidate.chat;
    }

    const revalidationCandidates: Array<{
      chat: ChatSummary;
      index: number;
      strict: boolean;
      options: {
        bypassNegativeCache: true;
        allowPersistedFallback?: false;
        entityType?: ManagedEntityType;
        trafficClass?: 'background';
        sourceTag?: string;
        timeoutMs?: number;
      };
    }> = [
      ...staleDeniedChats.map((candidate) => ({
        ...candidate,
        strict: true,
        options: {
          bypassNegativeCache: true as const,
          allowPersistedFallback: false as const,
          entityType: candidate.chat.entityType,
        },
      })),
      ...suspiciousChatsToRevalidate.map((candidate) => ({
        ...candidate,
        strict: false,
        options: {
          bypassNegativeCache: true as const,
          allowPersistedFallback: false as const,
          entityType: candidate.chat.entityType,
          trafficClass: 'background' as const,
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
          timeoutMs: MANAGED_ENTITIES_SUSPICIOUS_ALLOWLIST_ADMIN_TIMEOUT_MS,
        },
      })),
    ];

    if (revalidationCandidates.length > 0) {
      const revalidatedChats = await mapWithConcurrencyLimit(
        revalidationCandidates,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async ({ chat, strict, options }) => {
          const access = await this.resolveUserAndBotAdminAccess(chat.id, user.userId, options);

          if (strict) {
            return access.status === 'granted' ? chat : null;
          }

          return access.status === 'denied' ? null : chat;
        },
      );

      for (const [index, chat] of revalidatedChats.entries()) {
        if (!chat) {
          continue;
        }

        filtered[revalidationCandidates[index].index] = chat;
      }
    }

    return filtered.filter((chat): chat is ChatSummary => chat !== null);
  }

  private isSuspiciousManagedEntitiesAllowlistChat(chat: ChatSummary): boolean {
    return resolvePresentableManagedEntityTitle(chat.id, chat.title) === null;
  }

  private async discoverManagedEntitiesFromLocalCatalog(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      respectCooldown: boolean;
      fullScan: boolean;
      includeRefreshState?: boolean;
    },
  ): Promise<ManagedEntitiesListResult> {
    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(user.userId, entityType);
    const backoffActive = await this.isManagedEntitiesRefreshBackoffActive(
      user.userId,
      entityType,
      refreshCooldownKey,
    );
    const cooldownActive =
      options.respectCooldown &&
      (await this.isManagedEntitiesRefreshCooldownActive(
        user.userId,
        entityType,
        refreshCooldownKey,
      ));

    if (backoffActive || cooldownActive) {
      return {
        items: [],
        refresh:
          options.includeRefreshState === true
            ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType, {
                backoffActiveOverride: backoffActive,
              })
            : null,
      };
    }

    const discoveryKey = [
      user.userId,
      entityType,
      'local',
      options.fullScan ? 'full' : 'delta',
    ].join(':');
    const inFlight = this.managedEntitiesDiscoveryChecks.get(discoveryKey);
    const pending =
      inFlight ??
      this.runManagedEntitiesLocalDiscovery(user, entityType, refreshCooldownKey, options);

    if (!inFlight) {
      this.managedEntitiesDiscoveryChecks.set(discoveryKey, pending);
    }

    try {
      return await pending;
    } finally {
      if (!inFlight) {
        this.managedEntitiesDiscoveryChecks.delete(discoveryKey);
      }
    }
  }

  private async repairManagedEntitiesAllowlistAfterFullRefresh(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    verifiedItems: readonly ChatSummary[],
    candidateIds: readonly string[] | null | undefined,
  ): Promise<void> {
    const allowlist = await this.listChatsFromAllowlist(userId, entityType);
    if (allowlist.length === 0) {
      return;
    }

    const verifiedChatIds = new Set(verifiedItems.map((item) => item.id));
    const candidateChatIds = new Set(candidateIds ?? verifiedItems.map((item) => item.id));
    await mapWithConcurrencyLimit(allowlist, 8, async (chat) => {
      const cachedAccess = (await this.chatContextCache.getAdminAccess?.(chat.id, userId)) ?? null;
      if (cachedAccess === 'user_denied' || cachedAccess === 'bot_denied') {
        await this.managedEntityAccessRuntime.prunePersistedChatAccess(chat.id, userId);
        return null;
      }

      if (!candidateChatIds.has(chat.id)) {
        await this.managedEntityAccessRuntime.prunePersistedChatAccess(chat.id, userId);
        return null;
      }

      if (!verifiedChatIds.has(chat.id)) {
        return null;
      }

      if (!isFallbackTitle(chat.id, chat.title)) {
        return null;
      }

      const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
        chat.id,
        chat.entityType,
      );
      const presentableTitle = resolvePresentableManagedEntityTitle(
        chat.id,
        this.readTrimmedString(cachedHeader?.title),
      );
      if (presentableTitle) {
        await this.prisma.chat.update({
          where: { id: chat.id },
          data: { title: presentableTitle },
        });
        return null;
      }

      await this.managedEntityAccessRuntime.prunePersistedChatAccess(chat.id, userId);
      return null;
    });
  }

  private withManagedEntitiesFullScanCandidateIds(
    result: ManagedEntitiesListResult,
    candidateIds: readonly string[],
  ): ManagedEntitiesListResult {
    Object.defineProperty(result, 'fullScanCandidateIds', {
      value: [...candidateIds],
      enumerable: false,
      configurable: true,
    });
    return result;
  }

  private withManagedEntitiesAdminCheckCount(
    result: ManagedEntitiesListResult,
    count: number,
  ): ManagedEntitiesListResult {
    Object.defineProperty(result, 'adminCheckCount', {
      value: Math.max(0, Math.trunc(count)),
      enumerable: false,
      configurable: true,
    });
    return result;
  }

  private readManagedEntitiesAdminCheckCount(result: ManagedEntitiesListResult): number {
    const value = (result as ManagedEntitiesListResult & { adminCheckCount?: unknown })
      .adminCheckCount;
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  private async runManagedEntitiesLocalDiscovery(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    refreshCooldownKey: string,
    options: {
      respectCooldown: boolean;
      fullScan: boolean;
      includeRefreshState?: boolean;
    },
  ): Promise<ManagedEntitiesListResult> {
    const cachedChats = await this.listChatsFromAllowlist(user.userId, entityType);
    const cachedIds = new Set(cachedChats.map((chat) => chat.id));
    let storedCursor =
      options.fullScan === true
        ? ((await this.chatContextCache.getManagedEntitiesRefreshCursor?.(
            user.userId,
            entityType,
          )) ?? 0)
        : null;
    if (options.fullScan === true && storedCursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE) {
      storedCursor = 0;
      await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
    }
    const cachedAccessStates = await Promise.all(
      cachedChats.map(async (chat) => ({
        chat,
        cachedAccess: (await this.chatContextCache.getAdminAccess?.(chat.id, user.userId)) ?? null,
      })),
    );
    const staleDeniedCachedCandidates = cachedAccessStates
      .filter(
        (entry) => entry.cachedAccess === 'user_denied' || entry.cachedAccess === 'bot_denied',
      )
      .map((entry) => this.toManagedEntitiesDiscoveryCandidate(entry.chat));
    const prioritizedCandidateIds = new Set(staleDeniedCachedCandidates.map((chat) => chat.chatId));
    const candidateChats = this.mergeManagedEntitiesDiscoverySnapshots(
      staleDeniedCachedCandidates,
      await this.loadManagedEntitiesLocalDiscoverySnapshot(user, entityType, {
        limit: options.fullScan
          ? MANAGED_ENTITIES_LOCAL_CANDIDATE_LIMIT
          : MANAGED_ENTITIES_REFRESH_UNCACHED_LIMIT,
      }),
    );

    const fullScanStartIndex =
      options.fullScan === true
        ? Math.max(0, Math.min(storedCursor ?? 0, candidateChats.length))
        : 0;
    const fullScanEndIndex =
      options.fullScan === true
        ? Math.min(
            candidateChats.length,
            fullScanStartIndex + MANAGED_ENTITIES_LOCAL_REFRESH_SCAN_WINDOW_SIZE,
          )
        : 0;
    const candidateSlice = options.fullScan
      ? candidateChats.slice(fullScanStartIndex, fullScanEndIndex)
      : candidateChats
          .filter((chat) => !cachedIds.has(chat.chatId) || prioritizedCandidateIds.has(chat.chatId))
          .slice(0, MANAGED_ENTITIES_FOREGROUND_CANDIDATE_CHECK_LIMIT);

    try {
      const resolvedChats = await mapWithConcurrencyLimit(
        candidateSlice,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async (candidate) => {
          const access = await this.resolveUserAndBotAdminAccess(candidate.chatId, user.userId, {
            bypassNegativeCache: true,
            bypassPositiveCache: true,
            allowPersistedFallback: false,
            entityType: candidate.entityType,
            candidateBotIds: this.resolveManagedEntityDiscoveryBotIds(candidate),
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
            timeoutMs: MANAGED_ENTITIES_LOCAL_DISCOVERY_ADMIN_TIMEOUT_MS,
          });
          if (access.status === 'throttled') {
            throw new ManagedEntitiesRefreshThrottledError(access.error);
          }
          if (access.status === 'unknown') {
            return null;
          }
          if (access.status !== 'granted') {
            return {
              kind: 'remove' as const,
              chatId: candidate.chatId,
            };
          }
          if (!access.probeStartedAt) {
            return null;
          }

          const chat = await this.persistManagedEntityAccessBestEffort({
            chatId: candidate.chatId,
            userId: user.userId,
            title: candidate.title,
            entityType: candidate.entityType,
            link: candidate.link,
            avatarUrl: candidate.avatarUrl?.trim() ?? null,
            preferredBotId: candidate.botId ?? null,
            observedBotIds: candidate.botIds ?? [],
            source: 'local_discovery',
            probeStartedAt: access.probeStartedAt,
          });
          if (!chat) {
            return {
              kind: 'remove' as const,
              chatId: candidate.chatId,
            };
          }

          return {
            kind: 'include' as const,
            chat,
            lastEventTime: candidate.lastEventTime ?? 0,
          };
        },
      );

      await this.activateManagedEntitiesRefreshCooldown(
        user.userId,
        entityType,
        refreshCooldownKey,
      );

      const removedChatIds = new Set(
        resolvedChats
          .filter(
            (
              item,
            ): item is {
              kind: 'remove';
              chatId: string;
            } => item !== null && item.kind === 'remove',
          )
          .map((item) => item.chatId),
      );
      const grantedById = new Map(
        resolvedChats
          .filter(
            (
              item,
            ): item is {
              kind: 'include';
              chat: ChatSummary;
              lastEventTime: number;
            } => item !== null && item.kind === 'include',
          )
          .map((item) => [item.chat.id, item]),
      );
      const verifiedCached = cachedChats.filter((chat) => {
        if (grantedById.has(chat.id)) {
          return false;
        }
        if (removedChatIds.has(chat.id)) {
          return false;
        }

        return true;
      });
      const mergedChats = [
        ...grantedById.values(),
        ...verifiedCached.map((chat) => ({
          chat,
          lastEventTime: 0,
        })),
      ]
        .sort((left, right) => right.lastEventTime - left.lastEventTime)
        .map((item) => item.chat);
      const hydratedItems = await this.attachChannelOverview(
        await this.attachManagedEntityAvatars(mergedChats),
      );
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, hydratedItems);
      if (!options.fullScan) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
          user.userId,
          entityType,
          Array.from(grantedById.values()).map((item) => item.chat),
        );
      }

      let nextCursor: number | null = null;
      let completedAt: string | null = null;
      if (options.fullScan === true) {
        if (fullScanEndIndex >= candidateChats.length) {
          nextCursor = MANAGED_ENTITIES_REFRESH_CURSOR_DONE;
          await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
          completedAt = new Date().toISOString();
          await this.chatContextCache.setManagedEntitiesLastSyncedAt?.(
            user.userId,
            entityType,
            completedAt,
            MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC,
          );
        } else {
          nextCursor = fullScanEndIndex;
          await this.chatContextCache.setManagedEntitiesRefreshCursor?.(
            user.userId,
            entityType,
            fullScanEndIndex,
            MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC,
          );
        }
      }

      const result: ManagedEntitiesListResult = {
        items: hydratedItems,
        refresh:
          options.includeRefreshState === true
            ? options.fullScan === true
              ? createManagedEntitiesRefreshState(nextCursor, false, undefined, {
                  totalCandidates: candidateChats.length,
                  lastSyncedAt:
                    completedAt ??
                    (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(
                      user.userId,
                      entityType,
                    )) ??
                    null,
                })
              : createManagedEntitiesRefreshState(MANAGED_ENTITIES_REFRESH_CURSOR_DONE, false, 0, {
                  totalCandidates: null,
                  lastSyncedAt:
                    (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(
                      user.userId,
                      entityType,
                    )) ?? null,
                })
            : null,
      };
      const resultWithAdminCheckCount = this.withManagedEntitiesAdminCheckCount(
        result,
        candidateSlice.length,
      );
      return options.fullScan === true
        ? this.withManagedEntitiesFullScanCandidateIds(
            resultWithAdminCheckCount,
            candidateChats.map((chat) => chat.chatId),
          )
        : resultWithAdminCheckCount;
    } catch (error: unknown) {
      if (
        this.isManagedEntitiesRefreshThrottledError(error) ||
        isMaxApiThrottleError(error) ||
        isMaxApiTimeoutError(error)
      ) {
        const rootError =
          error instanceof ManagedEntitiesRefreshThrottledError ? error.cause : error;
        const backoffMs = await this.activateManagedEntitiesRefreshBackoff(
          user.userId,
          entityType,
          refreshCooldownKey,
        );
        this.logger.log(
          {
            entityType,
            userId: user.userId,
            backoffMs,
            err: rootError instanceof Error ? rootError.message : String(rootError),
          },
          'Paused local managed entity discovery after MAX API throttling',
        );
      } else {
        this.logger.warn(
          {
            entityType,
            userId: user.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to discover managed entities from local catalog',
        );
      }

      return {
        items: [],
        refresh:
          options.includeRefreshState === true
            ? await this.readLocalManagedEntitiesRefreshState(user.userId, entityType, {
                backoffActiveOverride:
                  this.isManagedEntitiesRefreshThrottledError(error) ||
                  isMaxApiThrottleError(error) ||
                  isMaxApiTimeoutError(error),
              })
            : null,
      };
    }
  }

  private async discoverManagedEntities(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options: {
      respectCooldown: boolean;
      fullScan: boolean;
      includeRefreshState?: boolean;
      bypassRemoteCache?: boolean;
      revalidateCachedChats?: boolean;
      resetRefreshCursor?: boolean;
      throwOnFailure?: boolean;
      allowRemoteListBotChats?: boolean;
    },
  ): Promise<ManagedEntitiesListResult> {
    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(user.userId, entityType);
    const backoffActive = await this.isManagedEntitiesRefreshBackoffActive(
      user.userId,
      entityType,
      refreshCooldownKey,
    );
    const cooldownActive =
      options.respectCooldown &&
      (await this.isManagedEntitiesRefreshCooldownActive(
        user.userId,
        entityType,
        refreshCooldownKey,
      ));

    if (!backoffActive && !cooldownActive) {
      const discoveryKey = [
        user.userId,
        entityType,
        options.fullScan ? 'full' : 'delta',
        options.bypassRemoteCache === true ? 'bypass' : 'cache',
        options.resetRefreshCursor === true ? 'reset' : 'resume',
      ].join(':');
      const inFlight = this.managedEntitiesDiscoveryChecks.get(discoveryKey);
      const pending =
        inFlight ??
        this.runManagedEntitiesDiscovery(user, entityType, refreshCooldownKey, {
          fullScan: options.fullScan,
          includeRefreshState: options.includeRefreshState === true,
          bypassRemoteCache: options.bypassRemoteCache === true,
          revalidateCachedChats: options.revalidateCachedChats === true,
          resetRefreshCursor: options.resetRefreshCursor === true,
          throwOnFailure: options.throwOnFailure === true,
          allowRemoteListBotChats: options.allowRemoteListBotChats === true,
        });

      if (!inFlight) {
        this.managedEntitiesDiscoveryChecks.set(discoveryKey, pending);
      }

      try {
        return await pending;
      } finally {
        if (!inFlight) {
          this.managedEntitiesDiscoveryChecks.delete(discoveryKey);
        }
      }
    }

    return {
      items: [],
      refresh:
        options.includeRefreshState === true
          ? await this.readManagedEntitiesRefreshState(user.userId, entityType, {
              backoffActiveOverride: backoffActive,
            })
          : null,
    };
  }

  private async runManagedEntitiesDiscovery(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    refreshCooldownKey: string,
    options: {
      fullScan: boolean;
      includeRefreshState?: boolean;
      bypassRemoteCache?: boolean;
      revalidateCachedChats?: boolean;
      resetRefreshCursor?: boolean;
      throwOnFailure?: boolean;
      allowRemoteListBotChats?: boolean;
    },
  ): Promise<ManagedEntitiesListResult> {
    try {
      const discoveryTrafficClass = 'background';
      const adminCheckSpacingMs = options.fullScan
        ? MANAGED_ENTITIES_FULL_SCAN_ADMIN_CHECK_SPACING_MS
        : MANAGED_ENTITIES_DELTA_ADMIN_CHECK_SPACING_MS;
      const adminCheckTimeoutMs = options.fullScan
        ? MANAGED_ENTITIES_REMOTE_FULL_SCAN_ADMIN_TIMEOUT_MS
        : MANAGED_ENTITIES_REMOTE_DELTA_ADMIN_TIMEOUT_MS;
      const snapshotTimeoutMs = options.fullScan
        ? MANAGED_ENTITIES_REMOTE_FULL_SCAN_SNAPSHOT_TIMEOUT_MS
        : MANAGED_ENTITIES_REMOTE_DELTA_SNAPSHOT_TIMEOUT_MS;
      const cachedChats = await this.listChatsFromAllowlist(user.userId, entityType);
      const cachedIds = new Set(cachedChats.map((chat) => chat.id));
      const cachedById = new Map(cachedChats.map((chat) => [chat.id, chat]));
      let storedCursor =
        options.fullScan === true
          ? ((await this.chatContextCache.getManagedEntitiesRefreshCursor?.(
              user.userId,
              entityType,
            )) ?? 0)
          : null;
      let supportedCandidateChats: ManagedEntitiesDiscoverySnapshot;

      if (options.fullScan === true) {
        if (options.resetRefreshCursor === true) {
          storedCursor = 0;
          await this.chatContextCache.clearManagedEntitiesRefreshCursor?.(user.userId, entityType);
          await this.chatContextCache.clearManagedEntitiesDiscoverySnapshot?.(
            user.userId,
            entityType,
          );
        }

        const startNewFullScan =
          options.resetRefreshCursor === true ||
          storedCursor === MANAGED_ENTITIES_REFRESH_CURSOR_DONE;
        const cachedSnapshot =
          startNewFullScan !== true
            ? ((await this.chatContextCache.getManagedEntitiesDiscoverySnapshot?.(
                user.userId,
                entityType,
              )) ?? null)
            : null;

        if (cachedSnapshot) {
          supportedCandidateChats = cachedSnapshot;
        } else {
          supportedCandidateChats = await this.loadManagedEntitiesDiscoverySnapshot(entityType, {
            trafficClass: discoveryTrafficClass,
            bypassCache: options.bypassRemoteCache === true,
            timeoutMs: snapshotTimeoutMs,
            allowRemoteListBotChats: options.allowRemoteListBotChats === true,
          });
          const priorityCandidates = await this.loadManagedEntitiesDeltaPrioritySnapshot(
            user,
            entityType,
          );
          if (priorityCandidates.length > 0) {
            supportedCandidateChats = this.mergeManagedEntitiesDiscoverySnapshots(
              priorityCandidates,
              supportedCandidateChats,
            );
          }
          storedCursor = 0;
          await this.chatContextCache.setManagedEntitiesDiscoverySnapshot?.(
            user.userId,
            entityType,
            supportedCandidateChats,
            MANAGED_ENTITIES_REFRESH_SNAPSHOT_TTL_SEC,
          );
        }
      } else {
        supportedCandidateChats = await this.loadManagedEntitiesDiscoverySnapshot(entityType, {
          trafficClass: discoveryTrafficClass,
          bypassCache: options.bypassRemoteCache === true,
          timeoutMs: snapshotTimeoutMs,
          allowRemoteListBotChats: options.allowRemoteListBotChats === true,
        });
        const priorityCandidates = await this.loadManagedEntitiesDeltaPrioritySnapshot(
          user,
          entityType,
        );
        if (priorityCandidates.length > 0) {
          supportedCandidateChats = this.mergeManagedEntitiesDiscoverySnapshots(
            priorityCandidates,
            supportedCandidateChats,
          );
        }
      }

      const remoteIndexByChatId = new Map(
        supportedCandidateChats.map((chat, index) => [chat.chatId, index]),
      );
      const fullScanStartIndex =
        options.fullScan === true
          ? Math.max(0, Math.min(storedCursor ?? 0, supportedCandidateChats.length))
          : 0;
      const fullScanEndIndex =
        options.fullScan === true
          ? Math.min(
              supportedCandidateChats.length,
              fullScanStartIndex + MANAGED_ENTITIES_REFRESH_SCAN_WINDOW_SIZE,
            )
          : 0;
      const mergedKnownChats = supportedCandidateChats.flatMap((remoteChat, remoteIndex) => {
        const cachedChat = cachedById.get(remoteChat.chatId);
        if (!cachedChat) {
          return [];
        }

        if (options.revalidateCachedChats === true) {
          return [];
        }

        const deferCachedChatToCurrentScanWindow =
          options.fullScan === true &&
          remoteIndex >= fullScanStartIndex &&
          remoteIndex < fullScanEndIndex;
        if (deferCachedChatToCurrentScanWindow) {
          return [];
        }

        cachedById.delete(remoteChat.chatId);
        return [
          {
            chat: {
              ...cachedChat,
              title: remoteChat.title?.trim() ? remoteChat.title : cachedChat.title,
              link: remoteChat.link,
              ...(remoteChat.avatarUrl?.trim() ? { avatarUrl: remoteChat.avatarUrl.trim() } : {}),
            },
            lastEventTime: remoteChat.lastEventTime ?? 0,
            remoteIndex,
          },
        ];
      });
      const uncachedCandidates = supportedCandidateChats.filter(
        (remoteChat) => !cachedIds.has(remoteChat.chatId),
      );
      const candidateSlice =
        options.fullScan === true
          ? supportedCandidateChats.slice(fullScanStartIndex, fullScanEndIndex)
          : options.revalidateCachedChats === true
            ? supportedCandidateChats
            : uncachedCandidates.slice(0, MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE);
      if (options.fullScan === true && candidateSlice.length > 0) {
        this.scheduleManagedEntitiesCatalogSync(candidateSlice, discoveryTrafficClass, {
          exhaustiveWindow: true,
          scopeKey: `${entityType}:full-window`,
        });
      }
      const resolvedChats = await mapWithConcurrencyLimit(
        candidateSlice,
        LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
        async (remoteChat) => {
          const cachedChat = cachedById.get(remoteChat.chatId) ?? null;
          const shouldRevalidateCachedChat =
            cachedChat !== null &&
            (options.fullScan === true || options.revalidateCachedChats === true);
          if (!shouldRevalidateCachedChat && cachedIds.has(remoteChat.chatId)) {
            return null;
          }
          if (adminCheckSpacingMs > 0) {
            await this.sleep(adminCheckSpacingMs);
          }
          const access = await this.resolveUserAndBotAdminAccess(remoteChat.chatId, user.userId, {
            bypassNegativeCache: true,
            bypassPositiveCache: true,
            allowPersistedFallback: false,
            entityType: remoteChat.entityType,
            candidateBotIds: this.resolveManagedEntityDiscoveryBotIds(remoteChat),
            trafficClass: discoveryTrafficClass,
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
            timeoutMs: adminCheckTimeoutMs,
          });
          if (access.status === 'throttled') {
            throw new ManagedEntitiesRefreshThrottledError(access.error);
          }
          if (access.status === 'unknown') {
            return null;
          }

          if (access.status !== 'granted') {
            if (shouldRevalidateCachedChat) {
              cachedById.delete(remoteChat.chatId);
            }
            return {
              kind: 'remove' as const,
              chatId: remoteChat.chatId,
            };
          }
          if (!access.probeStartedAt) {
            return null;
          }

          if (shouldRevalidateCachedChat) {
            cachedById.delete(remoteChat.chatId);
          }

          const chat = await this.persistManagedEntityAccessBestEffort({
            chatId: remoteChat.chatId,
            userId: user.userId,
            title: remoteChat.title,
            entityType: remoteChat.entityType,
            link: remoteChat.link,
            avatarUrl: remoteChat.avatarUrl?.trim() ?? null,
            createdAtFallback: cachedChat?.createdAt ?? null,
            preferredBotId: remoteChat.botId ?? null,
            observedBotIds: remoteChat.botIds ?? [],
            source: 'remote_discovery',
            probeStartedAt: access.probeStartedAt,
          });
          if (!chat) {
            return {
              kind: 'remove' as const,
              chatId: remoteChat.chatId,
            };
          }

          return {
            kind: 'include' as const,
            chat,
            lastEventTime: remoteChat.lastEventTime ?? 0,
            remoteIndex: remoteIndexByChatId.get(remoteChat.chatId) ?? Number.MAX_SAFE_INTEGER,
          };
        },
      );

      if (options.revalidateCachedChats === true) {
        const cachedChatIdsMissingFromRemoteSnapshot = [...cachedById.keys()].filter(
          (chatId) => !remoteIndexByChatId.has(chatId),
        );
        if (cachedChatIdsMissingFromRemoteSnapshot.length > 0) {
          await mapWithConcurrencyLimit(
            cachedChatIdsMissingFromRemoteSnapshot,
            LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
            async (chatId) => {
              await this.managedEntityAccessRuntime.prunePersistedChatAccessBestEffort(
                chatId,
                user.userId,
                'fresh_remote_discovery_missing_chat',
              );
            },
          );
        }
      }

      const removedChatIds = new Set(
        resolvedChats
          .filter(
            (
              item,
            ): item is {
              kind: 'remove';
              chatId: string;
            } => item !== null && item.kind === 'remove',
          )
          .map((item) => item.chatId),
      );
      if (options.revalidateCachedChats === true && removedChatIds.size > 0) {
        await mapWithConcurrencyLimit(
          [...removedChatIds],
          LIST_CHATS_ADMIN_CHECK_CONCURRENCY,
          async (chatId) => {
            await this.managedEntityAccessRuntime.prunePersistedChatAccessBestEffort(
              chatId,
              user.userId,
              'fresh_remote_discovery_denied_chat',
            );
          },
        );
      }
      const filtered = resolvedChats.filter(
        (
          item,
        ): item is {
          kind: 'include';
          chat: ChatSummary;
          lastEventTime: number;
          remoteIndex: number;
        } => item !== null && item.kind === 'include',
      );
      const remainingCachedChats =
        options.fullScan === true || options.revalidateCachedChats === true
          ? []
          : [...cachedById.values()].map((chat) => ({
              chat,
              lastEventTime: 0,
              remoteIndex: Number.MAX_SAFE_INTEGER,
            }));
      const mergedChats = [
        ...mergedKnownChats.filter((item) => !removedChatIds.has(item.chat.id)),
        ...filtered,
        ...remainingCachedChats,
      ];
      let nextCursor: number | null = null;
      let completedAt: string | null = null;

      if (options.fullScan === true) {
        if (fullScanEndIndex >= supportedCandidateChats.length) {
          nextCursor = MANAGED_ENTITIES_REFRESH_CURSOR_DONE;
          await this.chatContextCache.setManagedEntitiesRefreshCursor?.(
            user.userId,
            entityType,
            MANAGED_ENTITIES_REFRESH_CURSOR_DONE,
            MANAGED_ENTITIES_REFRESH_CURSOR_DONE_TTL_SEC,
          );
          await this.chatContextCache.clearManagedEntitiesDiscoverySnapshot?.(
            user.userId,
            entityType,
          );
          completedAt = new Date().toISOString();
          await this.chatContextCache.setManagedEntitiesLastSyncedAt?.(
            user.userId,
            entityType,
            completedAt,
            MANAGED_ENTITIES_REFRESH_LAST_SYNCED_TTL_SEC,
          );
        } else {
          nextCursor = fullScanEndIndex;
          await this.chatContextCache.setManagedEntitiesRefreshCursor?.(
            user.userId,
            entityType,
            fullScanEndIndex,
            MANAGED_ENTITIES_REFRESH_CURSOR_TTL_SEC,
          );
        }
      }

      await this.activateManagedEntitiesRefreshCooldown(
        user.userId,
        entityType,
        refreshCooldownKey,
      );

      mergedChats.sort((a, b) => {
        if (a.remoteIndex !== b.remoteIndex) {
          return a.remoteIndex - b.remoteIndex;
        }

        return b.lastEventTime - a.lastEventTime;
      });
      const items = await this.hydrateManagedEntities(
        mergedChats.map((item) => item.chat),
        {
          remoteChats: supportedCandidateChats,
        },
      );
      this.scheduleManagedEntityHeaderHydration(user.userId, entityType, items, {
        remoteChats: supportedCandidateChats,
      });
      if (!options.fullScan) {
        this.scheduleManagedEntitiesPublishedSnapshotRebuildForBootstrapChats(
          user.userId,
          entityType,
          filtered.map((item) => item.chat),
        );
      }
      const result: ManagedEntitiesListResult = {
        items,
        refresh:
          options.includeRefreshState === true
            ? options.fullScan === true
              ? createManagedEntitiesRefreshState(nextCursor, false, undefined, {
                  totalCandidates: supportedCandidateChats.length,
                  lastSyncedAt:
                    completedAt ??
                    (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(
                      user.userId,
                      entityType,
                    )) ??
                    null,
                })
              : await this.readManagedEntitiesRefreshState(user.userId, entityType)
            : null,
      };
      return options.fullScan === true
        ? this.withManagedEntitiesFullScanCandidateIds(
            result,
            supportedCandidateChats.map((chat) => chat.chatId),
          )
        : result;
    } catch (error: unknown) {
      if (
        this.isManagedEntitiesRefreshThrottledError(error) ||
        isMaxApiThrottleError(error) ||
        isMaxApiTimeoutError(error)
      ) {
        const rootError =
          error instanceof ManagedEntitiesRefreshThrottledError ? error.cause : error;
        const backoffMs = await this.activateManagedEntitiesRefreshBackoff(
          user.userId,
          entityType,
          refreshCooldownKey,
        );
        this.logger.warn(
          {
            entityType,
            userId: user.userId,
            backoffMs,
            err: rootError instanceof Error ? rootError.message : String(rootError),
          },
          'Paused remote chat discovery after MAX API throttling',
        );
      } else {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to auto-discover chats via MAX API',
        );
      }

      if (options.throwOnFailure === true) {
        throw error;
      }

      return {
        items: [],
        refresh:
          options.includeRefreshState === true
            ? await this.readManagedEntitiesRefreshState(user.userId, entityType, {
                backoffActiveOverride:
                  this.isManagedEntitiesRefreshThrottledError(error) ||
                  isMaxApiThrottleError(error) ||
                  isMaxApiTimeoutError(error),
              })
            : null,
      };
    }
  }

  private async loadManagedEntitiesDiscoverySnapshot(
    entityType: ManagedEntityTypeFilter,
    options: {
      trafficClass: 'critical' | 'interactive' | 'background';
      bypassCache?: boolean;
      timeoutMs?: number;
      allowRemoteListBotChats?: boolean;
    },
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    if (options.allowRemoteListBotChats !== true) {
      const localChats = await this.loadManagedBotChatCatalogSnapshot(null);
      const candidateChats =
        entityType === 'all'
          ? localChats
          : localChats.filter((chat) => chat.entityType === entityType);
      const supportedChats = candidateChats.filter(
        (chat) => !isUnsupportedManagedChat(chat.chatId, chat.entityType),
      );
      this.scheduleManagedEntitiesDiscoveryHeaderPrime(supportedChats, `local:${entityType}`);
      this.scheduleManagedEntitiesCatalogSync(supportedChats, options.trafficClass);
      return supportedChats;
    }

    if (typeof this.maxClient.listBotChats !== 'function') {
      const localChats = await this.loadManagedBotChatCatalogSnapshot(null);
      const candidateChats =
        entityType === 'all'
          ? localChats
          : localChats.filter((chat) => chat.entityType === entityType);
      return candidateChats.filter(
        (chat) => !isUnsupportedManagedChat(chat.chatId, chat.entityType),
      );
    }

    const discoveryBots = this.maxBotRegistry?.getDiscoveryBots() ?? [];
    if (discoveryBots.length === 0) {
      const legacyChats = await this.loadManagedBotChatsForDiscovery(null, options);
      const candidateChats =
        entityType === 'all'
          ? legacyChats
          : legacyChats.filter((chat) => chat.entityType === entityType);
      const supportedChats = candidateChats.filter(
        (chat) => !isUnsupportedManagedChat(chat.chatId, chat.entityType),
      );
      this.scheduleManagedEntitiesDiscoveryHeaderPrime(supportedChats, `legacy:${entityType}`);
      this.scheduleManagedEntitiesCatalogSync(supportedChats, options.trafficClass);

      return supportedChats;
    }

    const discoveryResults = await Promise.all(
      discoveryBots.map(async (bot) => {
        try {
          return {
            botId: bot.id,
            chats: await this.loadManagedBotChatsForDiscovery(bot.id, options),
            error: null,
          };
        } catch (error: unknown) {
          return {
            botId: bot.id,
            chats: [],
            error,
          };
        }
      }),
    );
    const failedResults = discoveryResults.filter((result) => result.error !== null);
    if (failedResults.length > 0) {
      this.logger.warn(
        {
          entityType,
          failedBots: failedResults.length,
          discoveryBots: discoveryBots.length,
          errors: failedResults.map((result) => ({
            botId: result.botId,
            err: result.error instanceof Error ? result.error.message : String(result.error),
          })),
        },
        'Continuing managed entities discovery with partial bot results',
      );
    }
    if (failedResults.length === discoveryResults.length && failedResults[0]?.error) {
      throw failedResults[0].error;
    }

    const remoteChats = this.mergeManagedEntitiesDiscoverySnapshots(
      ...discoveryResults.map((result) => result.chats),
    );
    const candidateChats =
      entityType === 'all'
        ? remoteChats
        : remoteChats.filter((chat) => chat.entityType === entityType);
    const supportedChats = candidateChats.filter(
      (chat) => !isUnsupportedManagedChat(chat.chatId, chat.entityType),
    );
    this.scheduleManagedEntitiesDiscoveryHeaderPrime(supportedChats, `multi:${entityType}`);
    this.scheduleManagedEntitiesCatalogSync(supportedChats, options.trafficClass);
    return supportedChats;
  }

  private async loadManagedBotChatsForDiscovery(
    botId: string | null,
    options: {
      trafficClass: 'critical' | 'interactive' | 'background';
      bypassCache?: boolean;
      timeoutMs?: number;
    },
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const normalizedBotId = this.normalizeRuntimeManagedEntityBotId(botId);
    try {
      const chats = await this.maxClient.listBotChats({
        trafficClass: options.trafficClass,
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        ...(options.bypassCache === true ? { bypassCache: true } : {}),
        ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
        ...(normalizedBotId ? { botId: normalizedBotId } : {}),
      });
      const normalizedChats = chats.map((chat) =>
        this.normalizeManagedBotChatDiscoverySnapshot(chat, normalizedBotId),
      );
      await this.replaceManagedBotChatCatalogSnapshot(normalizedChats, normalizedBotId).catch(
        (catalogError: unknown) => {
          this.logger.warn(
            {
              botId: normalizedBotId,
              candidateChats: normalizedChats.length,
              err: catalogError instanceof Error ? catalogError.message : String(catalogError),
            },
            'Failed to persist managed bot chat catalog snapshot',
          );
        },
      );
      const membershipChats = await this.loadManagedBotChatMembershipCatalogSnapshot(
        normalizedBotId,
      ).catch((membershipError: unknown) => {
        this.logger.warn(
          {
            botId: normalizedBotId,
            err:
              membershipError instanceof Error ? membershipError.message : String(membershipError),
          },
          'Failed to load managed bot chat membership discovery supplement',
        );
        return [];
      });
      return this.mergeManagedEntitiesDiscoverySnapshots(normalizedChats, membershipChats);
    } catch (error: unknown) {
      const fallbackChats = await this.loadManagedBotChatCatalogSnapshot(normalizedBotId).catch(
        (fallbackError: unknown) => {
          this.logger.warn(
            {
              botId: normalizedBotId,
              err: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            },
            'Failed to load managed bot chat catalog fallback',
          );
          return [];
        },
      );

      if (fallbackChats.length > 0) {
        this.logger.warn(
          {
            botId: normalizedBotId,
            fallbackChats: fallbackChats.length,
            err: error instanceof Error ? error.message : String(error),
          },
          'Using managed bot chat catalog fallback after MAX chat discovery failure',
        );
        return fallbackChats;
      }

      throw error;
    }
  }

  private normalizeManagedBotChatDiscoverySnapshot(
    chat: MaxBotChat,
    preferredBotId: string | null,
  ): MaxBotChat {
    const normalizedChatId = this.readTrimmedString(chat.chatId) ?? chat.chatId;
    const botIds = this.collectManagedBotChatCatalogBotIds(chat, preferredBotId);
    return {
      ...chat,
      chatId: normalizedChatId,
      botId:
        this.normalizeRuntimeManagedEntityBotId(chat.botId) ?? preferredBotId ?? botIds[0] ?? null,
      botIds,
    };
  }

  private async replaceManagedBotChatCatalogSnapshot(
    chats: readonly MaxBotChat[],
    pinnedBotId: string | null,
  ): Promise<void> {
    const catalog = this.prisma.managedBotChatCatalog;
    if (!catalog) {
      return;
    }

    const entriesByKey = new Map<
      string,
      {
        botId: string;
        chatId: string;
        entityType: ChatEntityType;
        title: string | null;
        link: string | null;
        avatarUrl: string | null;
        lastEventTime: string | null;
      }
    >();
    const seenChatIdsForPinnedBot = new Set<string>();

    for (const chat of chats) {
      const chatId = this.readTrimmedString(chat.chatId);
      if (!chatId) {
        continue;
      }
      const botIds = this.collectManagedBotChatCatalogBotIds(chat, pinnedBotId);
      if (pinnedBotId) {
        seenChatIdsForPinnedBot.add(chatId);
      }

      for (const botId of botIds) {
        entriesByKey.set(`${botId}\u0000${chatId}`, {
          botId,
          chatId,
          entityType: toPrismaEntityType(chat.entityType),
          title: this.readTrimmedString(chat.title),
          link: this.readTrimmedString(chat.link),
          avatarUrl: this.readTrimmedString(chat.avatarUrl),
          lastEventTime:
            typeof chat.lastEventTime === 'number' && Number.isFinite(chat.lastEventTime)
              ? String(Math.trunc(chat.lastEventTime))
              : null,
        });
      }
    }

    const entries = [...entriesByKey.values()];
    if (entries.length === 0) {
      return;
    }

    const now = new Date();
    await mapWithConcurrencyLimit(
      entries,
      MANAGED_BOT_CHAT_CATALOG_WRITE_CONCURRENCY,
      async (entry) => {
        const update: Prisma.ManagedBotChatCatalogUpdateInput = {
          entityType: entry.entityType,
          status: 'ACTIVE',
          source: 'max_chats',
          lastEventTime: entry.lastEventTime,
          lastSeenAt: now,
        };
        if (entry.title !== null) {
          update.title = entry.title;
        }
        if (entry.link !== null) {
          update.link = entry.link;
        }
        if (entry.avatarUrl !== null) {
          update.avatarUrl = entry.avatarUrl;
        }

        await catalog.upsert({
          where: {
            botId_chatId: {
              botId: entry.botId,
              chatId: entry.chatId,
            },
          },
          create: {
            botId: entry.botId,
            chatId: entry.chatId,
            entityType: entry.entityType,
            title: entry.title,
            link: entry.link,
            avatarUrl: entry.avatarUrl,
            lastEventTime: entry.lastEventTime,
            status: 'ACTIVE',
            source: 'max_chats',
            lastSeenAt: now,
          },
          update,
        });
        return null;
      },
    );

    if (
      pinnedBotId &&
      seenChatIdsForPinnedBot.size > 0 &&
      seenChatIdsForPinnedBot.size <= MANAGED_BOT_CHAT_CATALOG_MARK_MISSING_MAX_SEEN
    ) {
      await catalog.updateMany({
        where: {
          botId: pinnedBotId,
          status: 'ACTIVE',
          chatId: { notIn: [...seenChatIdsForPinnedBot] },
        },
        data: {
          status: 'MISSING',
        },
      });
    }
  }

  private async loadManagedBotChatCatalogSnapshot(
    botId: string | null,
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const catalog = this.prisma.managedBotChatCatalog;
    if (!catalog) {
      return [];
    }

    const runtimeBotIds = [...this.managedEntitiesRuntimeBotIds];
    const where: Prisma.ManagedBotChatCatalogWhereInput = {
      status: 'ACTIVE',
      ...(botId ? { botId } : runtimeBotIds.length > 0 ? { botId: { in: runtimeBotIds } } : {}),
    };
    const rows = await catalog.findMany({
      where,
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: MANAGED_BOT_CHAT_CATALOG_FALLBACK_LIMIT,
    });

    const catalogChats = this.mergeManagedBotChatCatalogRows(rows);
    const membershipChats = await this.loadManagedBotChatMembershipCatalogSnapshot(botId);
    return this.mergeManagedEntitiesDiscoverySnapshots(catalogChats, membershipChats);
  }

  private mergeManagedBotChatCatalogRows(
    rows: readonly ManagedBotChatCatalogSnapshotRow[],
  ): ManagedEntitiesDiscoverySnapshot {
    return mergeManagedBotChatCatalogRows(rows, (botId) =>
      this.normalizeRuntimeManagedEntityBotId(botId),
    );
  }

  private async loadManagedBotChatMembershipCatalogSnapshot(
    botId: string | null,
  ): Promise<ManagedEntitiesDiscoverySnapshot> {
    const memberships = this.prisma.chatBotMembership;
    if (!memberships) {
      return [];
    }

    const runtimeBotIds = [...this.managedEntitiesRuntimeBotIds];
    const where: Prisma.ChatBotMembershipWhereInput = {
      status: ChatBotMembershipStatus.ACTIVE,
      ...(botId ? { botId } : runtimeBotIds.length > 0 ? { botId: { in: runtimeBotIds } } : {}),
    };
    const rows = (await memberships.findMany({
      where,
      select: {
        botId: true,
        lastSeenAt: true,
        lastWebhookAt: true,
        chat: {
          select: {
            id: true,
            title: true,
            entityType: true,
            botId: true,
            primaryBotId: true,
          },
        },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: MANAGED_BOT_CHAT_CATALOG_FALLBACK_LIMIT,
    })) as ManagedBotChatMembershipSnapshotRow[];

    return this.mergeManagedBotChatMembershipRows(rows);
  }

  private mergeManagedBotChatMembershipRows(
    rows: readonly ManagedBotChatMembershipSnapshotRow[],
  ): ManagedEntitiesDiscoverySnapshot {
    const byChatId = new Map<string, MaxBotChat>();
    for (const row of rows) {
      const chatId = this.readTrimmedString(row.chat.id);
      const botId = this.normalizeRuntimeManagedEntityBotId(row.botId);
      if (!chatId || !botId) {
        continue;
      }

      const botIds = Array.from(
        new Set(
          [botId, row.chat.primaryBotId, row.chat.botId]
            .map((candidate) => this.normalizeRuntimeManagedEntityBotId(candidate))
            .filter((candidate): candidate is string => Boolean(candidate)),
        ),
      );
      const lastEventTime = row.lastWebhookAt?.getTime() ?? row.lastSeenAt?.getTime() ?? null;
      const existing = byChatId.get(chatId);
      if (existing) {
        existing.botIds = Array.from(new Set([...(existing.botIds ?? []), ...botIds]));
        existing.lastEventTime = Math.max(existing.lastEventTime ?? 0, lastEventTime ?? 0);
        continue;
      }

      byChatId.set(chatId, {
        chatId,
        title: this.readTrimmedString(row.chat.title),
        link: null,
        avatarUrl: null,
        entityType: fromPrismaEntityType(row.chat.entityType),
        lastEventTime,
        botId,
        botIds,
      });
    }

    return [...byChatId.values()];
  }

  private collectManagedBotChatCatalogBotIds(
    chat: MaxBotChat,
    preferredBotId: string | null,
  ): string[] {
    return Array.from(
      new Set(
        [preferredBotId, chat.botId, ...(chat.botIds ?? [])]
          .map((candidate) => this.normalizeRuntimeManagedEntityBotId(candidate))
          .filter((candidate): candidate is string => Boolean(candidate)),
      ),
    );
  }

  private scheduleManagedEntitiesDiscoveryHeaderPrime(
    chats: readonly MaxBotChat[],
    scopeKey: string,
  ): void {
    if (chats.length === 0 || typeof this.chatContextCache.setManagedEntityHeader !== 'function') {
      return;
    }

    const candidates = chats.filter((chat) => {
      return (
        this.readTrimmedString(chat.chatId) !== null &&
        (this.readTrimmedString(chat.title) !== null ||
          this.readTrimmedString(chat.link) !== null ||
          this.readTrimmedString(chat.avatarUrl) !== null)
      );
    });
    if (candidates.length === 0) {
      return;
    }

    const now = Date.now();
    const cooldownUntilMs =
      this.managedEntitiesDiscoveryHeaderPrimeCooldownUntilMs.get(scopeKey) ?? 0;
    if (cooldownUntilMs > now || this.managedEntitiesDiscoveryHeaderPrimeRuns.has(scopeKey)) {
      return;
    }

    this.managedEntitiesDiscoveryHeaderPrimeCooldownUntilMs.set(
      scopeKey,
      now + MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_COOLDOWN_MS,
    );

    const snapshot = candidates.map((chat) => ({ ...chat }));
    const pending = this.runManagedEntitiesDiscoveryHeaderPrime(snapshot)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            scopeKey,
            candidateChats: snapshot.length,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to prime managed entity headers from discovery snapshot',
        );
      })
      .finally(() => {
        if (this.managedEntitiesDiscoveryHeaderPrimeRuns.get(scopeKey) === pending) {
          this.managedEntitiesDiscoveryHeaderPrimeRuns.delete(scopeKey);
        }
      });

    this.managedEntitiesDiscoveryHeaderPrimeRuns.set(scopeKey, pending);
  }

  private async runManagedEntitiesDiscoveryHeaderPrime(
    chats: readonly MaxBotChat[],
  ): Promise<void> {
    await mapWithConcurrencyLimit(
      [...chats],
      MANAGED_ENTITIES_DISCOVERY_HEADER_PRIME_CONCURRENCY,
      async (chat) => {
        const chatId = this.readTrimmedString(chat.chatId);
        if (!chatId) {
          return null;
        }

        const existingHeader =
          (await this.chatContextCache.getManagedEntityHeader?.(chatId, chat.entityType)) ?? null;
        const title =
          resolvePresentableManagedEntityTitle(chatId, chat.title, existingHeader?.title) ??
          (chat.entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`);
        const link =
          this.readTrimmedString(chat.link) ?? this.readTrimmedString(existingHeader?.link) ?? null;
        const avatarUrl =
          this.readTrimmedString(chat.avatarUrl) ??
          this.readTrimmedString(existingHeader?.avatarUrl);
        const primaryBotId =
          this.normalizeRuntimeManagedEntityBotId(chat.botId) ??
          this.normalizeRuntimeManagedEntityBotId(existingHeader?.primaryBotId);
        await this.chatContextCache.setManagedEntityHeader?.(
          createManagedEntityHeader({
            id: chatId,
            title,
            entityType: chat.entityType,
            link,
            participantsCount: existingHeader?.participantsCount ?? null,
            avatarUrl,
            primaryBotId,
            assignedBots: existingHeader?.assignedBots,
            sharedMode: existingHeader?.sharedMode,
          }),
        );

        return null;
      },
    );
  }

  private scheduleManagedEntitiesCatalogSync(
    chats: readonly MaxBotChat[],
    trafficClass: 'critical' | 'interactive' | 'background',
    options: {
      exhaustiveWindow?: boolean;
      scopeKey?: string;
    } = {},
  ): void {
    if (!this.maxChatAdminRosterSyncService || chats.length === 0) {
      return;
    }

    const syncWindowSize =
      trafficClass === 'background'
        ? MANAGED_ENTITIES_BACKGROUND_CATALOG_SYNC_WINDOW_SIZE
        : MANAGED_ENTITIES_DELTA_DISCOVERY_WINDOW_SIZE;
    const syncCandidates =
      options.exhaustiveWindow === true
        ? chats
        : this.selectManagedEntitiesCatalogSyncWindow(
            chats,
            syncWindowSize,
            options.scopeKey ?? trafficClass,
          );
    if (syncCandidates.length === 0) {
      return;
    }

    const snapshot = syncCandidates.map((chat) => ({
      ...chat,
      botIds: Array.from(new Set([...(chat.botIds ?? []), ...(chat.botId ? [chat.botId] : [])])),
    }));

    void this.maxChatAdminRosterSyncService
      .scheduleDiscoverySnapshotSync(snapshot)
      .catch((error) => {
        this.logger.warn(
          {
            candidateChats: snapshot.length,
            trafficClass,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to enqueue managed entities catalog sync after discovery snapshot',
        );
      });
  }

  private selectManagedEntitiesCatalogSyncWindow<T>(
    items: readonly T[],
    windowSize: number,
    scopeKey: string,
  ): T[] {
    if (items.length === 0) {
      return [];
    }

    const boundedWindowSize = Math.max(1, Math.min(items.length, Math.trunc(windowSize)));
    const cursorKey = `managed-entities-catalog:${scopeKey}:${items.length}`;
    const startIndex =
      (this.managedEntitiesCatalogSyncCursorByScope.get(cursorKey) ?? 0) % items.length;
    const selected: T[] = [];
    for (let offset = 0; offset < boundedWindowSize; offset += 1) {
      selected.push(items[(startIndex + offset) % items.length]);
    }

    this.managedEntitiesCatalogSyncCursorByScope.set(
      cursorKey,
      (startIndex + boundedWindowSize) % items.length,
    );
    return selected;
  }

  async getChannelStats(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ChannelStatsResponse> {
    return this.channelStatsRuntime.getChannelStats(chatId, user, query);
  }

  private buildChannelStatsResponse(
    chatId: string,
    statsQuery: ChannelStatsQuery,
  ): Promise<ChannelStatsResponse> {
    return this.channelStatsRuntime.buildChannelStatsResponse(chatId, statsQuery);
  }

  private buildChannelStatsResponseCacheKey(
    ...args: Parameters<AdminChannelStatsRuntime['buildChannelStatsResponseCacheKey']>
  ): ReturnType<AdminChannelStatsRuntime['buildChannelStatsResponseCacheKey']> {
    return this.channelStatsRuntime.buildChannelStatsResponseCacheKey(...args);
  }

  async getChannelActivityFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<MembershipActivityPage> {
    return this.logsDashboardRuntime.getChannelActivityFeed(chatId, user, query);
  }

  async getSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatSettings> {
    await this.assertManagedEntityReadAccess(chatId, user.userId, 'chat', options);
    return readChatSettingsValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      logger: this.logger,
      chatId,
      botAssignmentData: await this.resolveChatSettingsReadBotAssignmentData(chatId),
    });
  }

  async getChatSettingsScreen(
    chatId: string,
    user: AuthUser,
    _options: { liveAdminCheck?: boolean } = {},
  ): Promise<ChatSettingsScreenResponse> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat', {
      forceRemote: true,
      timeoutMs: SETTINGS_SCREEN_ADMIN_CHECK_TIMEOUT_MS,
    });
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const [settings, rules, header, domains, managedBroadcasts] = await Promise.all([
      this.getSettings(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.getRules(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.getChatHeader(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.getDomainAllowlistDetails(chatId, user, { skipAdminCheck: true }),
      this.listManagedBroadcasts(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
    ]);
    const requiredSubscriptionChannels = await this.resolveRequiredSubscriptionChannelHeaders(
      settings.requiredSubscriptionChannelIds,
    );

    return chatSettingsScreenResponseSchema.parse({
      settings,
      reportsAvailable: this.reports?.available(chatId) ?? false,
      rules,
      header,
      requiredSubscriptionChannels,
      domains,
      managedBroadcasts,
    });
  }

  async resolveRequiredSubscriptionChannel(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ResolveRequiredSubscriptionChannelResponse> {
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = resolveRequiredSubscriptionChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channel = await this.resolveRequiredSubscriptionChannelReference(parsed.data.value);
    return resolveRequiredSubscriptionChannelResponseSchema.parse({ channel });
  }

  async resolveRequiredSubscriptionChannelReferenceValue(
    value: string,
  ): Promise<ManagedEntityHeader> {
    return this.resolveRequiredSubscriptionChannelReference(value);
  }

  async updateSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatSettings> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return saveChatSettingsValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
      resolveBotAssignmentData: () => this.resolveChatSettingsWriteBotAssignmentData(chatId),
      assertRequiredSubscriptionSettings: (settings) =>
        this.assertRequiredSubscriptionSettings(settings),
      reportsAvailable: (id) => this.reports?.available(id) ?? false,
      assertBotCapabilities: (requirements) =>
        this.assertChatSettingsBotCapabilities(chatId, requirements),
      refreshExecutionReadiness: (settings) =>
        this.refreshExecutionReadinessAfterChatSettingsUpdate(chatId, settings),
    });
  }

  async getRules(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatRules> {
    await this.assertManagedEntityReadAccess(chatId, user.userId, 'chat', options);

    const rules = await this.chatRulesTextRuntime.upsertChatRules(chatId);
    const hydratedRules = await this.chatRulesTextRuntime.hydratePublishedRulesUrl(chatId, rules);
    return this.chatRulesTextRuntime.mapChatRules(hydratedRules);
  }

  async updateRules(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return saveChatRulesDraft({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
    });
  }

  async adoptChatRulesFromMessage(
    chatId: string,
    user: AuthUser,
    input: AdoptChatRulesFromMessageInput,
    source: AdminActionSource = 'group_command',
    command?: GroupCommandPermit,
  ): Promise<ChatRules & { commandSkipped?: boolean }> {
    if (source === 'group_command' && !command)
      throw new BadRequestException('Group command identity is required');
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    await this.chatRulesTextRuntime.upsertChatRules(chatId);
    const sourceMessageId = this.readTrimmedString(input.sourceMessageId);
    let sourceMessageUrl = this.chatRulesTextRuntime.normalizePublishedRulesUrl(
      input.sourceMessageUrl,
    );
    if (!sourceMessageId && !sourceMessageUrl) {
      throw new BadRequestException('Не удалось определить сообщение с правилами.');
    }

    if (!sourceMessageUrl && sourceMessageId) {
      try {
        sourceMessageUrl = this.chatRulesTextRuntime.normalizePublishedRulesUrl(
          await this.maxClient.resolveMessageLink(sourceMessageId),
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            actorUserId: user.userId,
            messageId: sourceMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve chat rules message link from forwarded command',
        );
      }
    }

    let normalizedSourceText = this.chatRulesTextRuntime.normalizeImportedRulesText(input.text);
    let normalizedSourceTextFormat: ChatRules['textFormat'] = 'plain';
    const maxClientWithMessageMarkdown = this.maxClient as MaxClientService & {
      getMessageTextAsMarkdown?: MaxClientService['getMessageTextAsMarkdown'];
    };
    if (
      sourceMessageId &&
      typeof maxClientWithMessageMarkdown.getMessageTextAsMarkdown === 'function'
    ) {
      try {
        const formattedSourceText =
          await maxClientWithMessageMarkdown.getMessageTextAsMarkdown(sourceMessageId);
        const normalizedFormattedSourceText =
          this.chatRulesTextRuntime.normalizeImportedRulesText(formattedSourceText);
        if (normalizedFormattedSourceText) {
          normalizedSourceText = normalizedFormattedSourceText;
          normalizedSourceTextFormat = 'markdown';
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            actorUserId: user.userId,
            messageId: sourceMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to recover formatted chat rules text from source message',
        );
      }
    }

    const resolvedBotId =
      command?.executionBotId ?? (await this.resolveManualActionBotAssignment(chatId));
    // FLAG: Adopting an old human message must establish independent protection before
    // changing its role. Force the first-binding race closed whenever Lastik is configured.
    await confirmEraserSourceHolds(
      this.prisma,
      [{ chatId, messageId: sourceMessageId ?? '' }],
      [],
      this.configService.get<boolean>('ERASER_ENABLED', false) === true ||
        Boolean(
          this.configService.get<string>('ERASER_CONTROL_URL') &&
          this.configService.get<string>('ERASER_CONTROL_TOKEN'),
        ),
    );
    const authority = new GroupCommandAuthorityService(this.prisma);
    const saved = await this.prisma.$transaction(async (tx) => {
      const applies = await advanceChatMutationOrder(tx, chatId, 'RULES', command);
      if (command) await authority.assertOwned(command, tx);
      const result: GroupCommandResult = {
        action: 'RULES',
        applied: applies,
        noticeText: applies
          ? 'Правила привязаны к этому сообщению. Кнопка «Правила» в нарушениях включена.'
          : null,
      };
      if (!applies) {
        if (command) await authority.prepareResult(command, result, tx);
        return { rules: await tx.chatRules.findUniqueOrThrow({ where: { chatId } }), result };
      }
      const activeRules = await tx.chatRules.findUniqueOrThrow({ where: { chatId } });
      if (
        activeRules.publishOperationId ||
        activeRules.publishSendStartedAt ||
        activeRules.pendingCleanupMessageId
      ) {
        throw new BadRequestException(
          'Публикация или очистка правил уже выполняется. Повторите позже.',
        );
      }
      const publishedAt = new Date();
      const updatedRules = await tx.chatRules.update({
        where: { chatId },
        data: {
          ...(normalizedSourceText !== null
            ? {
                text: normalizedSourceText,
                textFormat: normalizedSourceTextFormat,
                autoTextEnabled: false,
              }
            : {}),
          publishedMessageId: sourceMessageId ?? null,
          publishedUrl: sourceMessageUrl,
          publishedAt,
          publishedBotId: resolvedBotId ?? null,
        },
      });

      await tx.chat.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          title: `Chat ${chatId}`,
          entityType: ChatEntityType.CHAT,
          ...this.buildResolvedBotAssignmentData(resolvedBotId),
          settings: {
            create: {
              rulesAttachViolationsEnabled: true,
            },
          },
        },
        update: {
          settings: {
            upsert: {
              update: {
                rulesAttachViolationsEnabled: true,
              },
              create: {
                rulesAttachViolationsEnabled: true,
              },
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'ADOPT_CHAT_RULES_MESSAGE',
          payload: {
            previousPublishedMessageId: activeRules.publishedMessageId ?? null,
            previousPublishedUrl: activeRules.publishedUrl ?? null,
            messageId: sourceMessageId ?? null,
            url: sourceMessageUrl,
            copiedText: normalizedSourceText !== null,
            textFormat: normalizedSourceText !== null ? normalizedSourceTextFormat : null,
            textLength: normalizedSourceText?.length ?? 0,
            rulesAttachViolationsEnabled: true,
            botId: resolvedBotId ?? null,
            source,
            ...(command ? { commandKey: command.semanticKey, result } : {}),
          },
        },
      });
      if (command) await authority.prepareResult(command, result, tx);
      return { rules: updatedRules, result };
    });
    if (command) command.result = saved.result;
    if (saved.result.applied) await this.chatContextCache.invalidate(chatId);
    return {
      ...this.chatRulesTextRuntime.mapChatRules(saved.rules),
      ...(!saved.result.applied ? { commandSkipped: true } : {}),
    };
  }

  async publishRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
    mode?: 'new_message' | 'update',
  ): Promise<PublishChatRulesResult> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return publishChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      actorUserId: user.userId,
      source,
      mode,
      resolveBotId: () => this.resolveChatRulesActionBotId(chatId),
      buildAutofilledText: () => this.buildAutofilledChatRulesTextFromCurrentSettings(chatId, user),
      buildFormattedText: (sourceText, options) =>
        this.buildFormattedChatRulesPublicationText(chatId, sourceText, options),
      sendPrivateConfirmation: (publishedUrl, operation) =>
        this.sendPublishedChatRulesPrivateConfirmation(user, publishedUrl, operation),
      deletePreviousPublishedMessage: (cleanup) =>
        this.getManualMessageCleanupService().deleteChatRulesMessage({
          ...cleanup,
          source,
          actorUserId: user.userId,
        }),
    });
  }

  async resetPublishedRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return resetPublishedChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      actorUserId: user.userId,
      source,
      resolveBotId: () => this.resolveChatRulesActionBotId(chatId),
      deletePublishedMessage: (cleanup) =>
        this.getManualMessageCleanupService().deleteChatRulesMessage({
          ...cleanup,
          source,
          actorUserId: user.userId,
        }),
    });
  }

  async getChannelSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChannelSettings> {
    await this.assertManagedEntityReadAccess(chatId, user.userId, 'channel', options);
    const botAssignmentData = await this.resolveChannelSettingsReadBotAssignmentData(chatId);
    return readChannelSettingsValue({
      prisma: this.prisma,
      logger: this.logger,
      chatId,
      botAssignmentData,
    });
  }

  async getChannelSettingsScreen(
    chatId: string,
    user: AuthUser,
    _options: { liveAdminCheck?: boolean } = {},
  ): Promise<ChannelSettingsScreenResponse> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'channel', {
      forceRemote: true,
      timeoutMs: SETTINGS_SCREEN_ADMIN_CHECK_TIMEOUT_MS,
    });
    await this.ensureEntityType(chatId, user.userId, 'channel');

    const [settings, postSignature, header, managedBroadcasts] = await Promise.all([
      this.getChannelSettings(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
      this.channelPostSignatureService?.getSettings(chatId) ??
        Promise.resolve({ enabled: false, text: CHANNEL_POST_SIGNATURE_DEFAULT_TEXT, url: '' }),
      this.getChannelHeader(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.listChannelManagedBroadcasts(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
    ]);

    return channelSettingsScreenResponseSchema.parse({
      settings,
      postSignature,
      header,
      managedBroadcasts,
    });
  }

  async updateChannelSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChannelSettings> {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return saveChannelSettingsValue({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
      resolveBotAssignmentData: () => this.resolveChannelSettingsWriteBotAssignmentData(chatId),
      refreshExecutionReadiness: () => this.refreshChannelSettingsExecutionReadiness(chatId),
    });
  }

  async publishChannelEngagementMessage(chatId: string, user: AuthUser, body: unknown) {
    await this.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    const channelPostSignatureService = this.channelPostSignatureService;
    return publishChannelEngagementMessageValue({
      prisma: this.prisma,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      body,
      resolveBotId: () => this.resolveChannelEngagementActionBotId(chatId),
      resolveEditBotId: () => this.resolveChannelEngagementEditBotId(chatId),
      buildDialogArtifacts: (params) => this.buildChannelEngagementDialogArtifacts(params),
      ...(channelPostSignatureService
        ? {
            prepareText: (payload) =>
              channelPostSignatureService.preparePostText(chatId, payload, {
                entityType: 'channel',
                trafficClass: 'interactive',
                sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
              }),
            buildCtaButton: () =>
              channelPostSignatureService.buildPostButton(chatId, {
                entityType: 'channel',
                trafficClass: 'interactive',
                sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
              }),
          }
        : {}),
    });
  }

  async getChannelDialog(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    token: string | null,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    if (dialogProfile === 'publisher') {
      return this.publisherDialogProfileRuntime.getChannelDialog({
        chatId,
        user,
        dialogTypeRaw,
        token,
        mapAuditLog: (...args) => this.mapChannelDialogAuditLog(...args),
      });
    }
    const threadId = this.dialogLinkHelper.resolveChannelDialogThreadId(chatId, dialogType, token);
    const action =
      dialogType === 'comments' ? CHANNEL_DIALOG_ACTION_COMMENT : CHANNEL_DIALOG_ACTION_SUGGEST;
    const [channelSettings, rows, adminUserIds, notificationSettings] = await Promise.all([
      this.getPublicChannelSettings(chatId),
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action,
          ...(threadId
            ? {
                payload: {
                  path: ['threadId'],
                  equals: threadId,
                },
              }
            : {}),
          ...(dialogType === 'suggest' ? { actorUserId: user.userId } : {}),
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: CHANNEL_DIALOG_MESSAGES_LIMIT + 1,
      }),
      dialogType === 'comments'
        ? this.dialogAdminAccessRuntime.readPersisted(chatId, 'channel')
        : Promise.resolve(new Set<string>()),
      dialogType === 'comments'
        ? this.readEntityDialogNotificationSettings({
            entityType: 'channel',
            chatId,
            threadId,
            userId: user.userId,
          })
        : Promise.resolve(DEFAULT_DIALOG_NOTIFICATION_SETTINGS),
    ]);

    const messages = rows
      .slice(0, CHANNEL_DIALOG_MESSAGES_LIMIT)
      .reverse()
      .map((row) => this.mapChannelDialogAuditLog(row, dialogType, user.userId, adminUserIds));

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      introText: this.resolveChannelDialogIntroText(channelSettings, dialogType),
      messages,
      notificationSettings,
      hasMoreMessages: rows.length > CHANNEL_DIALOG_MESSAGES_LIMIT,
    });
  }

  async getChannelSuggestionRedirect(chatId: string, token: string | null) {
    return getChannelSuggestionRedirectValue({
      chatId,
      token,
      dialogLinkHelper: this.dialogLinkHelper,
      loadChannelSettings: (channelId) => this.getPublicChannelSettings(channelId),
      resolveBotId: (channelId) => this.resolveBotAssignment(channelId),
    });
  }

  async createChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    return this.createChannelDialogMessageInternal(
      chatId,
      user,
      dialogType,
      body,
      'miniapp_dialog',
      dialogProfile,
    );
  }

  async createChannelSuggestionFromBot(
    chatId: string,
    user: AuthUser,
    body: unknown,
    trustedContext: { mediaBotId?: string | null } = {},
  ) {
    const parsed = this.parseChannelSuggestionFromBotPayload(body);
    const mediaBotId = this.resolveTrustedChannelSuggestionMediaBotId(
      parsed,
      trustedContext.mediaBotId,
    );
    const threadId = this.dialogLinkHelper.resolveChannelDialogThreadId(
      chatId,
      'suggest',
      parsed.token,
    );
    const channelSettings = await this.getPublicChannelSettings(chatId);

    if (!channelSettings.postSuggestionsEnabled && !threadId) {
      throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
    }

    await this.assertChannelSuggestionDailyLimit(chatId, user.userId, channelSettings);

    const created = await this.createChannelSuggestionAuditLog({
      chatId,
      user,
      threadId,
      source: 'private_bot',
      text: parsed.text,
      textFormat: parsed.textFormat,
      textMarkup: parsed.textMarkup,
      images: parsed.images,
      imageBase64: parsed.imageBase64,
      imageMimeType: parsed.imageMimeType,
      imageFileName: parsed.imageFileName,
      mediaType: parsed.mediaType,
      mediaPayload: parsed.mediaPayload,
      mediaMimeType: parsed.mediaMimeType,
      mediaFileName: parsed.mediaFileName,
      mediaBotId,
    });

    return {
      ok: true,
      delivered: created.delivered,
      queued: created.queued,
    } as const;
  }

  async getPublicChannelSuggestionIntroText(chatId: string): Promise<string | null> {
    const channelSettings = await this.getPublicChannelSettings(chatId);
    return this.resolveChannelDialogIntroText(channelSettings, 'suggest');
  }

  getPublicChannelSettingsForDialog(chatId: string): Promise<ChannelSettings> {
    return this.getPublicChannelSettings(chatId);
  }

  getPublicChatCommentSettingsForDialog(
    chatId: string,
  ): Promise<Pick<ChatSettings, 'commentsEnabled'>> {
    return this.getPublicChatCommentSettings(chatId);
  }

  getPublicPublisherChatCommentSettingsForDialog(
    chatId: string,
  ): Promise<Pick<ChatSettings, 'commentsEnabled'>> {
    return this.publisherDialogProfileRuntime.readChatCommentSettings(chatId);
  }

  getPublicPublisherChannelCommentSettingsForDialog(
    _chatId: string,
  ): Promise<{ commentsEnabled: boolean }> {
    return Promise.resolve({ commentsEnabled: true });
  }

  async toggleEntityDialogReactionForDialog(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    emoji: string;
    dialogProfile?: MiniappProfile;
  }): Promise<ToggleChannelDialogReactionResponse> {
    if (params.dialogProfile === 'publisher') {
      if (params.entityType === 'channel') {
        await this.publisherDialogProfileRuntime.assertChannelCommentThreadReady(params.chatId);
      } else {
        await this.publisherDialogProfileRuntime.assertChatReady(params.chatId);
      }
    }
    return this.toggleEntityDialogReaction(params);
  }

  async getPublicChannelSuggestionTarget(
    chatId: string,
  ): Promise<{ title: string; link: string | null }> {
    await this.getPublicChannelSettings(chatId);

    const persistedChat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        title: true,
      },
    });

    try {
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      });
      return {
        title: snapshot.title?.trim() || persistedChat?.title?.trim() || chatId,
        link: this.readTrimmedString(snapshot.link),
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve public channel suggestion target',
      );
      return {
        title: persistedChat?.title?.trim() || chatId,
        link: null,
      };
    }
  }

  async reviewChannelSuggestionByAdmin(
    suggestionId: string,
    user: AuthUser,
    action: ChannelSuggestionReviewAction,
  ) {
    return this.channelSuggestionPublicationRuntime.review(suggestionId, user, action);
  }
  parseChannelSuggestionStartPayload(
    startPayload: string | null,
  ): { chatId: string; token: string } | null {
    return this.dialogLinkHelper.parseChannelSuggestionStartPayload(startPayload);
  }
  private async createChannelDialogMessageInternal(
    chatId: string,
    user: AuthUser,
    dialogType: ChannelDialogType,
    body: unknown,
    source: ChannelDialogMessageSource,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    if (dialogProfile === 'publisher' && dialogType === 'suggest') {
      return this.publisherDialogProfileRuntime.createChannelSuggestion({
        chatId,
        user,
        dialogType,
        body,
        mapAuditLog: (...args) => this.mapChannelDialogAuditLog(...args),
      });
    }
    const parsed = createChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const threadId =
      dialogProfile === 'publisher'
        ? this.publisherDialogProfileRuntime.resolveRequiredPublisherThreadId(
            chatId,
            'channel',
            dialogType,
            parsed.data.token,
          )
        : this.dialogLinkHelper.resolveChannelDialogThreadId(chatId, dialogType, parsed.data.token);
    const text = parsed.data.text.trim();
    const normalizedAttachments = this.normalizeChannelDialogCommentInputAttachments(
      parsed.data.attachments,
    );
    const parsedImages = parsed.data.images.map((image) => ({
      base64: image.base64?.trim() ?? '',
      mimeType: image.mimeType?.trim() ?? '',
      fileName: image.fileName?.trim() ?? '',
    }));
    const attachmentImages = normalizedAttachments
      .filter((attachment) => attachment.kind === 'image')
      .map((image) => ({
        base64: image.base64?.trim() ?? '',
        mimeType: image.mimeType?.trim() ?? '',
        fileName: image.fileName?.trim() ?? '',
      }));
    const images =
      dialogType === 'suggest' && parsedImages.length > 0 ? parsedImages : attachmentImages;
    const fileAttachments = normalizedAttachments.filter(
      (attachment) => attachment.kind === 'file',
    );
    if (dialogProfile === 'publisher' && normalizedAttachments.length > 0) {
      throw new BadRequestException('В комментариях Публика пока доступен только текст.');
    }
    const authorDisplayName = user.displayName?.trim() ? user.displayName.trim() : user.username;
    const authorAvatarUrl = this.readTrimmedString(user.avatarUrl);
    const replyTo = await this.resolveDialogReplyPreview({
      chatId,
      entityType: 'channel',
      dialogType,
      threadId,
      replyToMessageId: parsed.data.replyToMessageId ?? null,
      dialogProfile,
    });
    const channelSettings =
      dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readChannelCommentThreadSettings(chatId)
        : await this.getPublicChannelSettings(chatId);

    if (dialogType === 'comments' && !channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    if (dialogType === 'comments' && !text && normalizedAttachments.length === 0) {
      throw new BadRequestException('Введите текст комментария или добавьте вложение.');
    }

    if (dialogType === 'suggest' && !channelSettings.postSuggestionsEnabled && !threadId) {
      throw new BadRequestException('Предложить пост для этого канала сейчас нельзя.');
    }

    if (dialogType === 'suggest' && fileAttachments.length > 0) {
      throw new BadRequestException('В предложке пока поддерживаются только фото.');
    }

    if (dialogType !== 'suggest' && parsed.data.video) {
      throw new BadRequestException('Видео доступно только в предложке.');
    }

    if (dialogType === 'suggest' && !text && images.length === 0 && !parsed.data.video) {
      throw new BadRequestException('Введите текст или добавьте фото или видео.');
    }

    if (dialogType === 'suggest') {
      await this.assertChannelSuggestionDailyLimit(chatId, user.userId, channelSettings);
    }

    if (
      dialogProfile !== 'publisher' &&
      dialogType === 'comments' &&
      channelSettings.commentsModerationEnabled
    ) {
      await this.assertChannelCommentAllowed({
        chatId,
        threadId,
        authorUserId: user.userId,
        text,
        settings: channelSettings,
      });
    }

    if (dialogType === 'suggest') {
      const created = await this.createChannelSuggestionAuditLog({
        chatId,
        user,
        threadId,
        source,
        text,
        textFormat: parsed.data.textFormat,
        images,
        video: parsed.data.video,
      });
      return createChannelDialogMessageResponseSchema.parse({
        ok: true,
        message: this.mapChannelDialogAuditLog(created.row, 'suggest', user.userId),
      });
    }
    return this.createEntityCommentDialogMessageInternal({
      entityType: 'channel',
      chatId,
      user,
      dialogType,
      threadId,
      text,
      normalizedAttachments,
      replyTo,
      source,
      authorDisplayName,
      authorAvatarUrl,
      dialogProfile,
    });
  }

  async getChatDialog(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    token: string | null,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }
    if (dialogProfile === 'publisher') {
      return this.publisherDialogProfileRuntime.getChatCommentsDialog({
        chatId,
        user,
        dialogTypeRaw,
        token,
        mapAuditLog: (...args) => this.mapChannelDialogAuditLog(...args),
      });
    }

    const threadId = this.dialogLinkHelper.resolveChatDialogThreadId(chatId, dialogType, token);
    const [chatSettings, rows, adminUserIds, notificationSettings] = await Promise.all([
      this.getPublicChatCommentSettings(chatId),
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          ...(threadId
            ? {
                payload: {
                  path: ['threadId'],
                  equals: threadId,
                },
              }
            : {}),
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: CHANNEL_DIALOG_MESSAGES_LIMIT + 1,
      }),
      this.dialogAdminAccessRuntime.readPersisted(chatId, 'chat'),
      this.readEntityDialogNotificationSettings({
        entityType: 'chat',
        chatId,
        threadId,
        userId: user.userId,
      }),
    ]);

    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    const messages = rows
      .slice(0, CHANNEL_DIALOG_MESSAGES_LIMIT)
      .reverse()
      .map((row) => this.mapChannelDialogAuditLog(row, dialogType, user.userId, adminUserIds));

    return channelDialogResponseSchema.parse({
      chatId,
      type: dialogType,
      introText: null,
      messages,
      notificationSettings,
      hasMoreMessages: rows.length > CHANNEL_DIALOG_MESSAGES_LIMIT,
    });
  }

  async createChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    return this.createChatDialogMessageInternal(
      chatId,
      user,
      dialogTypeRaw,
      body,
      'miniapp_dialog',
      dialogProfile,
    );
  }

  async updateChannelDialogNotifications(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const channelSettings =
      dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readChannelCommentThreadSettings(chatId)
        : await this.getPublicChannelSettings(chatId);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Уведомления доступны только в комментариях.');
    }
    if (dialogProfile === 'publisher') {
      return this.publisherDialogProfileRuntime.updateCommentNotifications(
        chatId,
        'channel',
        user.userId,
        body,
      );
    }
    if (!channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    return this.updateEntityDialogNotifications({
      entityType: 'channel',
      chatId,
      userId: user.userId,
      dialogType,
      body,
    });
  }

  async updateChatDialogNotifications(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const chatSettings =
      dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readChatCommentSettings(chatId)
        : await this.getPublicChatCommentSettings(chatId);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }
    if (dialogProfile === 'publisher') {
      return this.publisherDialogProfileRuntime.updateCommentNotifications(
        chatId,
        'chat',
        user.userId,
        body,
      );
    }
    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    return this.updateEntityDialogNotifications({
      entityType: 'chat',
      chatId,
      userId: user.userId,
      dialogType,
      body,
    });
  }

  private async createChatDialogMessageInternal(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    source: ChannelDialogMessageSource,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    if (dialogType !== 'comments') {
      throw new BadRequestException('Для чатов доступен только сценарий комментариев.');
    }
    if (dialogProfile === 'publisher') {
      await this.publisherDialogProfileRuntime.assertChatReady(chatId);
    }

    const parsed = createChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    if (parsed.data.video) throw new BadRequestException('Видео доступно только в предложке.');
    const threadId = this.publisherDialogProfileRuntime.resolveChatThreadId(
      chatId,
      dialogType,
      parsed.data.token,
      dialogProfile,
    );
    const text = parsed.data.text.trim();
    const normalizedAttachments = this.normalizeChannelDialogCommentInputAttachments(
      parsed.data.attachments,
    );
    if (dialogProfile === 'publisher' && normalizedAttachments.length > 0) {
      throw new BadRequestException('В комментариях Публика пока доступен только текст.');
    }
    const authorDisplayName = user.displayName?.trim() ? user.displayName.trim() : user.username;
    const authorAvatarUrl = this.readTrimmedString(user.avatarUrl);
    const replyTo = await this.resolveDialogReplyPreview({
      chatId,
      entityType: 'chat',
      dialogType,
      threadId,
      replyToMessageId: parsed.data.replyToMessageId ?? null,
      dialogProfile,
    });
    const chatSettings =
      dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readChatCommentSettings(chatId)
        : await this.getPublicChatCommentSettings(chatId);

    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    if (!text && normalizedAttachments.length === 0) {
      throw new BadRequestException('Введите текст комментария или добавьте вложение.');
    }

    return this.createEntityCommentDialogMessageInternal({
      entityType: 'chat',
      chatId,
      user,
      dialogType,
      threadId,
      text,
      normalizedAttachments,
      replyTo,
      source,
      authorDisplayName,
      authorAvatarUrl,
      dialogProfile,
    });
  }

  private async createEntityCommentDialogMessageInternal(params: {
    entityType: DialogMessageEntityType;
    chatId: string;
    user: AuthUser;
    dialogType: 'comments';
    threadId: string | null;
    text: string;
    normalizedAttachments: ChannelDialogAttachmentAsset[];
    replyTo: ChannelDialogReplyPreview | null;
    source: ChannelDialogMessageSource;
    authorDisplayName: string | null;
    authorAvatarUrl: string | null;
    dialogProfile?: MiniappProfile;
  }) {
    const uploadedAttachments = await this.uploadChannelDialogCommentAttachments(
      params.chatId,
      params.normalizedAttachments,
    );

    const created = await createCommentDialogAudit(
      this.prisma,
      params,
      uploadedAttachments,
      this.publisherCommentNotifications,
    );

    const message = {
      id: created.id,
      type: params.dialogType,
      text: params.text,
      authorUserId: params.user.userId,
      authorDisplayName: params.authorDisplayName ?? null,
      isAdmin: (params.dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readAdminUserIds(
            params.chatId,
            params.entityType,
          )
        : await this.dialogAdminAccessRuntime.readRemoteOrPersisted(params.chatId)
      ).has(params.user.userId),
      avatarUrl: params.authorAvatarUrl ?? null,
      createdAt: created.createdAt.toISOString(),
      editedAt: null,
      replyToMessageId: params.replyTo?.messageId ?? null,
      replyTo: params.replyTo ?? null,
      attachments: this.buildChannelDialogCommentAttachments(uploadedAttachments),
      reactionGroups: [],
      canEdit: true,
      canDelete: true,
      canDeleteAsAdmin: false,
    };

    if (params.threadId) {
      await this.syncCommentsButtonCount({
        chatId: params.chatId,
        entityType: params.entityType,
        threadId: params.threadId,
        dialogProfile: params.dialogProfile,
      });
    }

    if (params.dialogProfile === 'publisher') {
      void this.publisherCommentNotifications!.enqueue(created.id);
    } else {
      await this.ensureEntityDialogReplySubscription({
        entityType: params.entityType,
        chatId: params.chatId,
        threadId: params.threadId,
        userId: params.user.userId,
      });
      void this.deliverEntityDialogCommentNotifications({
        entityType: params.entityType,
        chatId: params.chatId,
        threadId: params.threadId,
        messageId: created.id,
        authorUserId: params.user.userId,
        authorDisplayName: params.authorDisplayName,
        text: params.text,
        attachmentCount: uploadedAttachments.length,
        replyToMessageId: params.replyTo?.messageId ?? null,
      }).catch((error: unknown) => {
        this.logger.warn(
          {
            chatId: params.chatId,
            entityType: params.entityType,
            messageId: created.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule comment dialog notifications',
        );
      });
    }

    return createChannelDialogMessageResponseSchema.parse({
      ok: true,
      message,
    });
  }

  private async updateEntityDialogNotifications(params: {
    entityType: ManagedEntityType;
    chatId: string;
    userId: string;
    dialogType: ChannelDialogType;
    body: unknown;
  }) {
    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Уведомления доступны только в комментариях.');
    }

    const parsed = updateChannelDialogNotificationsRequestSchema.safeParse(params.body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const threadId =
      params.entityType === 'channel'
        ? this.dialogLinkHelper.resolveChannelDialogThreadId(
            params.chatId,
            params.dialogType,
            parsed.data.token,
          )
        : this.dialogLinkHelper.resolveChatDialogThreadId(
            params.chatId,
            params.dialogType,
            parsed.data.token,
          );
    const notificationSettings = await this.upsertEntityDialogNotificationSubscription({
      entityType: params.entityType,
      chatId: params.chatId,
      threadId,
      userId: params.userId,
      mode: parsed.data.mode,
      scope: parsed.data.scope,
    });

    return updateChannelDialogNotificationsResponseSchema.parse({
      ok: true,
      notificationSettings,
    });
  }

  async updateChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = updateChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channelSettings =
      dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readChannelCommentThreadSettings(chatId)
        : await this.getPublicChannelSettings(chatId);
    if (!channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    return this.updateEntityDialogMessage({
      chatId,
      entityType: 'channel',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
      text: parsed.data.text,
      dialogProfile,
    });
  }

  async deleteChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = deleteChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channelSettings =
      dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readChannelCommentThreadSettings(chatId)
        : await this.getPublicChannelSettings(chatId);
    if (!channelSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого канала сейчас закрыты.');
    }

    return this.deleteEntityDialogMessage({
      chatId,
      entityType: 'channel',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
      dialogProfile,
    });
  }

  async updateChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = updateChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    if (dialogProfile === 'publisher') {
      await this.publisherDialogProfileRuntime.assertChatReady(chatId);
    }

    const chatSettings =
      dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readChatCommentSettings(chatId)
        : await this.getPublicChatCommentSettings(chatId);
    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    return this.updateEntityDialogMessage({
      chatId,
      entityType: 'chat',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
      text: parsed.data.text,
      dialogProfile,
    });
  }

  async deleteChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    const dialogType = channelDialogTypeSchema.parse(dialogTypeRaw);
    const parsed = deleteChannelDialogMessageRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    if (dialogProfile === 'publisher') {
      await this.publisherDialogProfileRuntime.assertChatReady(chatId);
    }

    const chatSettings =
      dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readChatCommentSettings(chatId)
        : await this.getPublicChatCommentSettings(chatId);
    if (!chatSettings.commentsEnabled) {
      throw new BadRequestException('Комментарии для этого чата сейчас закрыты.');
    }

    return this.deleteEntityDialogMessage({
      chatId,
      entityType: 'chat',
      userId: user.userId,
      dialogType,
      messageId,
      token: parsed.data.token,
      dialogProfile,
    });
  }

  async toggleChannelDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
  ) {
    return toggleDialogReactionValue({
      chatId,
      entityType: 'channel',
      messageId,
      user,
      dialogTypeRaw,
      body,
      loadCommentSettings: (channelId) => this.getPublicChannelSettings(channelId),
      toggleReaction: (options) => this.toggleEntityDialogReaction(options),
    });
  }

  async toggleChatDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile: MiniappProfile = 'moderation',
  ) {
    return toggleDialogReactionValue({
      chatId,
      entityType: 'chat',
      messageId,
      user,
      dialogTypeRaw,
      body,
      dialogProfile,
      loadCommentSettings: (chatId) =>
        dialogProfile === 'publisher'
          ? this.publisherDialogProfileRuntime.readChatCommentSettings(chatId)
          : this.getPublicChatCommentSettings(chatId),
      toggleReaction: (options) => this.toggleEntityDialogReaction(options),
    });
  }

  async applySettingsToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    targetOrSettingKeys: ApplySettingsTarget | readonly (keyof ChatSettings)[] = {
      mode: 'all',
      favoriteTypes: [],
      chatIds: [],
    },
    settingKeys?: readonly (keyof ChatSettings)[],
    botSpeechMediaKeys?: readonly string[],
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.assertManagedEntityAdminAccess(sourceChatId, user.userId, 'chat');
    return applySettingsToAllChatsValue({
      commercialAiDeleteOnly:
        this.configService.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED') === true,
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      sourceChatId,
      actorUserId: user.userId,
      body,
      source,
      targetOrSettingKeys,
      settingKeys,
      botSpeechMediaKeys,
      normalizeSettings: (settings) => this.normalizeChatSettingsForApply(sourceChatId, settings),
      resolveTargetChats: (target) =>
        this.resolveSettingsApplyTargetChatsForSettings(sourceChatId, user, target),
      resolveBotAssignmentData: (chatId) => this.resolveSettingsApplyBotAssignmentData(chatId),
      assertRequiredSubscriptionSettings: (settings) =>
        this.assertRequiredSubscriptionSettingsForChatSettings(settings),
      reportsAvailable: (id) => this.reports?.available(id) ?? false,
      assertBotCapabilities: (chatId, requirements) =>
        this.assertChatSettingsBotCapabilities(chatId, requirements),
      recordConcurrentWriteConflict: (params) =>
        this.logger.warn(params, 'Bulk chat settings write stopped after a revision conflict'),
      onPartialApplied: () => Promise.resolve(),
      isRequiredSubscriptionCurrentlyActive: (settings) =>
        this.isRequiredSubscriptionCurrentlyActiveForSettings(settings),
      scheduleReadinessRefresh: (params) =>
        this.scheduleApplySettingsToAllReadinessRefreshForSettings(params),
      getCurrentSourceSettings: () => this.getSettings(sourceChatId, user),
    });
  }

  async applySettingsSectionToAllChats(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ApplySectionToAllResponse> {
    return applySettingsSectionToAllChatsValue({
      sourceChatId,
      body,
      source,
      getSourceSettings: () => this.getSettings(sourceChatId, user),
      getSourceStopWordsSettings: async () => {
        await this.assertManagedEntityReadAccess(sourceChatId, user.userId, 'chat');
        return readChatSettingsSnapshotValue({
          prisma: this.prisma,
          chatContextCache: this.chatContextCache,
          logger: this.logger,
          chatId: sourceChatId,
          botAssignmentData: await this.resolveChatSettingsReadBotAssignmentData(sourceChatId),
        });
      },
      applySettings: (settings, target, settingKeys, botSpeechMediaKeys) =>
        this.applySettingsToAllChats(
          sourceChatId,
          user,
          settings,
          source,
          target,
          settingKeys,
          botSpeechMediaKeys,
        ),
      syncDomainAllowlistToChats: (targetChatIds) =>
        this.syncDomainAllowlistToChatsForSettings(sourceChatId, targetChatIds),
    });
  }

  private async resolveSettingsApplyTargetChats(
    sourceChatId: string,
    user: AuthUser,
    target: ApplySettingsTarget,
  ): Promise<ChatSummary[]> {
    const availableChats = await this.listChatsForMassBroadcast(user, {
      discoveryMode: 'cached-first',
    });
    const sourceChat =
      availableChats.find((chat) => chat.id === sourceChatId) ??
      this.createManagedEntitySummary({
        id: sourceChatId,
        title: `Chat ${sourceChatId}`,
        createdAt: new Date().toISOString(),
        entityType: 'chat',
      });
    const selectableChats = mergeManagedEntityGroups([sourceChat], availableChats);
    const selectableById = new Map(selectableChats.map((chat) => [chat.id, chat]));

    if (target.mode === 'current') {
      return [sourceChat];
    }

    if (target.mode === 'all') {
      return selectableChats;
    }

    if (target.mode === 'selectedChats') {
      return this.resolveOrderedTargetChats(target.chatIds, selectableById);
    }

    const favoriteTypes =
      target.mode === 'allFavorites' ? MANAGED_ENTITY_FAVORITE_TYPE_ORDER : target.favoriteTypes;
    const favoriteChatIds = await this.listFavoriteChatIdsForSettingsTarget(
      user.userId,
      favoriteTypes,
    );
    return this.resolveOrderedTargetChats(favoriteChatIds, selectableById);
  }

  private resolveOrderedTargetChats(
    chatIds: readonly string[],
    selectableById: ReadonlyMap<string, ChatSummary>,
  ): ChatSummary[] {
    const seen = new Set<string>();
    const targetChats: ChatSummary[] = [];

    for (const chatId of chatIds) {
      const normalizedChatId = this.readTrimmedString(chatId);
      if (!normalizedChatId || seen.has(normalizedChatId)) {
        continue;
      }

      const chat = selectableById.get(normalizedChatId);
      if (!chat) {
        continue;
      }

      seen.add(normalizedChatId);
      targetChats.push(chat);
    }

    return targetChats;
  }

  private async listFavoriteChatIdsForSettingsTarget(
    userId: string,
    favoriteTypes: readonly ManagedEntityFavoriteType[],
  ): Promise<string[]> {
    return listCanonicalFavoriteChatIdsForSettingsTarget(this.prisma, userId, favoriteTypes);
  }

  private normalizeStoredLinkButtons(
    rawButtons: unknown,
    legacy?: {
      buttonUrl?: string | null;
      buttonText?: string | null;
    },
  ): BroadcastLinkButton[] {
    return normalizeStoredLinkButtonsValue(rawButtons, legacy);
  }

  private buildStoredLinkButtonState(
    rawButtons: unknown,
    legacy?: {
      buttonUrl?: string | null;
      buttonText?: string | null;
    },
  ): {
    buttons: BroadcastLinkButton[];
    buttonUrl: string;
    buttonText: string;
  } {
    return buildStoredLinkButtonStateValue(rawButtons, legacy);
  }

  private async resolveRequiredSubscriptionChannelHeaders(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]> {
    return this.requiredSubscriptionRuntime.resolveRequiredSubscriptionChannelHeaders(channelIds);
  }

  private async resolveRequiredSubscriptionChannelReference(
    value: string,
  ): Promise<ManagedEntityHeader> {
    return this.requiredSubscriptionRuntime.resolveRequiredSubscriptionChannelReference(value);
  }

  private buildRequiredSubscriptionChannelUrlCandidates(
    value: string | null | undefined,
  ): string[] {
    return this.requiredSubscriptionRuntime.buildRequiredSubscriptionChannelUrlCandidates(value);
  }

  private extractRequiredSubscriptionChannelIdFromValue(
    value: string | null | undefined,
  ): string | null {
    return this.requiredSubscriptionRuntime.extractRequiredSubscriptionChannelIdFromValue(value);
  }

  private async resolveRequiredSubscriptionChannelByLink(link: string): Promise<MaxBotChat> {
    return this.requiredSubscriptionRuntime.resolveRequiredSubscriptionChannelByLink(link);
  }

  private extractRequiredSubscriptionPublicChannelLink(normalizedLink: string): string | null {
    return this.requiredSubscriptionRuntime.extractRequiredSubscriptionPublicChannelLink(
      normalizedLink,
    );
  }

  private async resolveRequiredSubscriptionChannelById(
    chatId: string,
    options: {
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
    } = {},
  ): Promise<ManagedEntityHeader> {
    return this.requiredSubscriptionRuntime.resolveRequiredSubscriptionChannelById(chatId, options);
  }

  private async assertBotCanInspectRequiredSubscriptionChannel(
    chatId: string,
    options: {
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
    } = {},
  ): Promise<string | null> {
    return this.requiredSubscriptionRuntime.assertBotCanInspectRequiredSubscriptionChannel(
      chatId,
      options,
    );
  }

  private normalizeRequiredSubscriptionChannelLink(
    value: string | null | undefined,
  ): string | null {
    return this.requiredSubscriptionRuntime.normalizeRequiredSubscriptionChannelLink(value);
  }

  private async assertRequiredSubscriptionSettings(settings: ChatSettings): Promise<ChatSettings> {
    return this.requiredSubscriptionRuntime.assertRequiredSubscriptionSettings(settings);
  }

  private async resolveRequiredSubscriptionEntityType(chatId: string): Promise<ManagedEntityType> {
    return this.requiredSubscriptionRuntime.resolveRequiredSubscriptionEntityType(chatId);
  }

  private async refreshRequiredSubscriptionAccessSnapshots(
    entityIds: readonly string[],
    reason: string,
  ): Promise<void> {
    await this.requiredSubscriptionRuntime.refreshRequiredSubscriptionAccessSnapshots(
      entityIds,
      reason,
    );
  }

  async sendBroadcast(
    ..._args: Parameters<AdminManagedBroadcastRuntime['sendBroadcast']>
  ): Promise<SendBroadcastResult> {
    throwLegacyPublicationWritesDisabled();
  }

  async sendChannelBroadcast(
    ..._args: Parameters<AdminManagedBroadcastRuntime['sendChannelBroadcast']>
  ): Promise<SendBroadcastResult> {
    throwLegacyPublicationWritesDisabled();
  }

  async sendBroadcastTest(
    ..._args: Parameters<AdminManagedBroadcastRuntime['sendBroadcastTest']>
  ): Promise<SendBroadcastTestResult> {
    throwLegacyPublicationWritesDisabled();
  }

  async sendChannelBroadcastTest(
    ..._args: Parameters<AdminManagedBroadcastRuntime['sendChannelBroadcastTest']>
  ): Promise<SendBroadcastTestResult> {
    throwLegacyPublicationWritesDisabled();
  }

  sendPublicationBroadcastTest(
    ...args: Parameters<AdminManagedBroadcastRuntime['sendPublicationBroadcastTest']>
  ): Promise<SendBroadcastTestResult> {
    return this.managedBroadcastRuntime.sendPublicationBroadcastTest(...args);
  }

  sendPublicationChannelBroadcastTest(
    ...args: Parameters<AdminManagedBroadcastRuntime['sendPublicationChannelBroadcastTest']>
  ): Promise<SendBroadcastTestResult> {
    return this.managedBroadcastRuntime.sendPublicationChannelBroadcastTest(...args);
  }

  listManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.managedBroadcastRuntime.listManagedBroadcasts(sourceChatId, user, options);
  }

  listChannelManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.managedBroadcastRuntime.listChannelManagedBroadcasts(sourceChatId, user, options);
  }

  getManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.managedBroadcastRuntime.getManagedBroadcastCalendar(sourceChatId, user, query);
  }

  getChannelManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.managedBroadcastRuntime.getChannelManagedBroadcastCalendar(
      sourceChatId,
      user,
      query,
    );
  }

  getManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.getManagedBroadcast(sourceChatId, broadcastId, user);
  }

  getChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.getChannelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  async updateManagedBroadcast(
    ..._args: Parameters<AdminManagedBroadcastRuntime['updateManagedBroadcast']>
  ): Promise<ManagedBroadcastDetails> {
    throwLegacyPublicationWritesDisabled();
  }

  async updateChannelManagedBroadcast(
    ..._args: Parameters<AdminManagedBroadcastRuntime['updateChannelManagedBroadcast']>
  ): Promise<ManagedBroadcastDetails> {
    throwLegacyPublicationWritesDisabled();
  }

  cancelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.cancelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  cancelChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.managedBroadcastRuntime.cancelChannelManagedBroadcast(
      sourceChatId,
      broadcastId,
      user,
    );
  }

  async retryManagedBroadcast(
    ..._args: Parameters<AdminManagedBroadcastRuntime['retryManagedBroadcast']>
  ): Promise<ManagedBroadcastDetails> {
    throwLegacyPublicationWritesDisabled();
  }

  async retryChannelManagedBroadcast(
    ..._args: Parameters<AdminManagedBroadcastRuntime['retryChannelManagedBroadcast']>
  ): Promise<ManagedBroadcastDetails> {
    throwLegacyPublicationWritesDisabled();
  }

  processDueManagedBroadcasts(reason: 'startup' | 'scheduled'): Promise<void> {
    return this.managedBroadcastRuntime.processDueManagedBroadcasts(reason);
  }

  processDueImmediatePublicationBroadcasts(
    ...args: Parameters<AdminManagedBroadcastRuntime['processDueImmediatePublicationBroadcasts']>
  ): ReturnType<AdminManagedBroadcastRuntime['processDueImmediatePublicationBroadcasts']> {
    return this.managedBroadcastRuntime.processDueImmediatePublicationBroadcasts(...args);
  }

  processTargetedImmediatePublicationBroadcasts(
    ...args: Parameters<
      AdminManagedBroadcastRuntime['processTargetedImmediatePublicationBroadcasts']
    >
  ): ReturnType<AdminManagedBroadcastRuntime['processTargetedImmediatePublicationBroadcasts']> {
    return this.managedBroadcastRuntime.processTargetedImmediatePublicationBroadcasts(...args);
  }

  processTargetedDeadlinePublicationBroadcasts(
    ...args: Parameters<
      AdminManagedBroadcastRuntime['processTargetedDeadlinePublicationBroadcasts']
    >
  ): ReturnType<AdminManagedBroadcastRuntime['processTargetedDeadlinePublicationBroadcasts']> {
    return this.managedBroadcastRuntime.processTargetedDeadlinePublicationBroadcasts(...args);
  }

  processDueDeadlinePublicationBroadcasts(
    ...args: Parameters<AdminManagedBroadcastRuntime['processDueDeadlinePublicationBroadcasts']>
  ): ReturnType<AdminManagedBroadcastRuntime['processDueDeadlinePublicationBroadcasts']> {
    return this.managedBroadcastRuntime.processDueDeadlinePublicationBroadcasts(...args);
  }

  private normalizeBroadcastTextFormat(value: string): 'markdown' | 'plain' {
    return channelDialogValues.normalizeBroadcastTextFormat(value);
  }

  private resolveManagedBroadcastSendRetryDelayMs(
    error: unknown,
    attempt: number,
    options: ManagedBroadcastRetriableAttachmentOptions,
  ): number | null {
    return resolveManagedBroadcastSendRetryDelayMsValue(error, attempt, options);
  }

  private sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  private async safeDeleteManagedBroadcast(broadcastId: string): Promise<void> {
    try {
      await this.prisma.managedBroadcast.delete({
        where: { id: broadcastId },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          broadcastId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clean up managed broadcast after transaction error',
      );
    }
  }

  private isManagedBroadcastSlotConflictError(error: unknown): boolean {
    return isManagedBroadcastSlotConflictErrorValue(error);
  }

  private extractMaxApiErrorMessage(error: unknown): string {
    return extractMaxApiErrorMessageValue(error);
  }

  private decodeBroadcastImageBase64(value: string): Buffer {
    return decodeBroadcastImageBase64Value(value);
  }

  private decodeRulesImageBase64(value: string): Buffer {
    return decodeRulesImageBase64Value(value);
  }

  private resolveBroadcastImageFileName(fileName: string, mimeType: string): string {
    return resolveBroadcastImageFileNameValue(fileName, mimeType);
  }

  private normalizeManagedBroadcastButtons(
    rawButtons: unknown,
    legacy?: ManagedBroadcastLegacyButtonState,
  ): BroadcastLinkButton[] {
    return normalizeManagedBroadcastButtonsValue(rawButtons, legacy);
  }

  private buildManagedBroadcastButtonState(
    rawButtons: unknown,
    legacy?: ManagedBroadcastLegacyButtonState,
  ) {
    return buildManagedBroadcastButtonStateValue(rawButtons, legacy);
  }

  private buildBroadcastLinkButtonRows(
    buttons: readonly BroadcastLinkButton[],
    options?: { buttonsPerRow?: number },
  ): MaxMessageButton[][] {
    return buildManagedBroadcastLinkButtonRows(buttons, options);
  }

  async buildChannelPublicationEngagementContext(
    chatId: string,
    botId?: string | null,
  ): Promise<ChannelPublicationEngagementContext> {
    const settings = await this.getPublicChannelSettings(chatId);
    const includeCommentsButton = settings.commentsEnabled;
    const includeSuggestButton = settings.postSuggestionsEnabled;
    const ctaButton = await this.channelPostSignatureService?.buildPostButton(chatId, {
      entityType: 'channel',
      trafficClass: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
    });

    if (!includeCommentsButton && !includeSuggestButton && !ctaButton) {
      return {
        buttons: [],
        threadId: null,
        includeCommentsButton,
        includeSuggestButton,
        suggestButtonText: null,
        suggestionEntryMode: settings.postSuggestionsEntryMode,
      };
    }

    const threadId = includeCommentsButton || includeSuggestButton ? randomUUID() : null;
    const suggestButtonText = settings.postSuggestionsButtonText.trim() || '📰 Предложить пост';
    const commentsButton =
      includeCommentsButton && threadId
        ? this.buildChannelDialogButton(
            chatId,
            'comments',
            threadId,
            formatCommentsButtonText('💬 Комментарии', 0),
            botId,
          )
        : null;
    const suggestButton =
      includeSuggestButton && threadId
        ? this.buildChannelDialogButton(
            chatId,
            'suggest',
            threadId,
            suggestButtonText,
            botId,
            settings.postSuggestionsEntryMode,
          )
        : null;
    const buttons = buildChannelPostActionRows({ commentsButton, suggestButton, ctaButton });

    return {
      buttons,
      threadId,
      includeCommentsButton,
      includeSuggestButton,
      suggestButtonText: includeSuggestButton ? suggestButtonText : null,
      suggestionEntryMode: settings.postSuggestionsEntryMode,
      buttonRows: buttons.map((row) => row.map((button) => ({ ...button }))),
      commentsButton: includeCommentsButton
        ? { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' }
        : null,
    };
  }

  async recordChannelPublicationEngagement(params: {
    chatId: string;
    actorUserId: string;
    messageId: string;
    text?: string | null;
    publishedUrl?: string | null;
    context: ChannelPublicationEngagementContext;
    source: string;
    botId?: string | null;
  }): Promise<void> {
    const { chatId, actorUserId, messageId, text, publishedUrl, context, source, botId } = params;
    if (
      !messageId.trim() ||
      !context.threadId ||
      (!context.includeCommentsButton && !context.includeSuggestButton)
    ) {
      return;
    }

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action: CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
        payload: {
          messageId,
          threadId: context.threadId,
          includeCommentsButton: context.includeCommentsButton,
          includeSuggestButton: context.includeSuggestButton,
          suggestionEntryMode: context.suggestionEntryMode,
          source,
          ...(this.readRawString(text)?.trim() ? { text } : {}),
          ...(publishedUrl ? { publishedUrl } : {}),
          ...(botId ? { botId } : {}),
          ...(context.suggestButtonText ? { suggestButtonText: context.suggestButtonText } : {}),
          ...(context.buttonRows ? { buttonRows: context.buttonRows } : {}),
          ...(context.commentsButton !== undefined
            ? { commentsButton: context.commentsButton }
            : {}),
        },
      },
    });
  }

  private async resolveBroadcastButtons(
    chatId: string,
    entityType: ManagedEntityType,
    options: {
      customButtons?: BroadcastLinkButton[];
      buttonEnabled?: boolean;
      buttonUrl?: string;
      buttonText?: string;
      includeCustomButton: boolean;
      customButtonText: string;
      customButtonUrl: string;
    },
    botId?: string,
  ): Promise<MaxMessageButton[][]> {
    return (await this.resolveBroadcastButtonContext(chatId, entityType, options, botId)).buttons;
  }

  private resolveBroadcastButtonContext(
    chatId: string,
    entityType: ManagedEntityType,
    options: ManagedBroadcastButtonContextOptions,
    botId?: string,
  ): Promise<ManagedBroadcastButtonContextResult> {
    return resolveManagedBroadcastButtonContext(
      {
        prisma: this.prisma,
        channelPostSignatureService: this.channelPostSignatureService,
        shouldIncludeChatCommentsButton: (settings) =>
          this.shouldIncludeChatCommentsButton(settings),
        buildChatDialogButton: (...args) => this.dialogLinkHelper.buildChatDialogButton(...args),
        buildChannelDialogButton: (...args) => this.buildChannelDialogButton(...args),
      },
      chatId,
      entityType,
      options,
      botId,
    );
  }

  private buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
    suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] = 'BOT',
  ): MaxMessageButton {
    if (type === 'suggest' && suggestionEntryMode !== 'MINIAPP') {
      const startPayload = this.dialogLinkHelper.buildChannelSuggestionStartPayload(
        chatId,
        threadId,
        botId,
      );
      const botStartUrl = this.dialogLinkHelper.buildBotStartUrl(startPayload, botId);
      if (botStartUrl) {
        return {
          type: 'link',
          text,
          url: botStartUrl,
        };
      }
    }

    const launchUrl = this.dialogLinkHelper.buildChannelDialogLaunchUrl(
      chatId,
      type,
      threadId,
      botId,
    );
    const webAppUrl = this.dialogLinkHelper.buildChannelDialogDirectWebAppUrl(
      chatId,
      type,
      threadId,
    );
    const botContactId = this.dialogLinkHelper.resolveBotContactId(botId);

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

  private readChannelSuggestionEntryMode(
    value: unknown,
  ): ChannelSettings['postSuggestionsEntryMode'] {
    return this.readTrimmedString(value)?.toUpperCase() === 'MINIAPP' ? 'MINIAPP' : 'BOT';
  }

  private resolveRulesImageFileName(fileName: string, mimeType: string): string {
    return resolveRulesImageFileNameValue(fileName, mimeType);
  }

  private resolveChannelDialogIntroText(
    settings: ChannelSettings,
    dialogType: ChannelDialogType,
  ): string | null {
    const value =
      dialogType === 'suggest' ? settings.postSuggestionsText : settings.commentsMessageText;
    const normalized = value.trim();
    return normalized || null;
  }

  private isMaxMessageMissingError(error: unknown): boolean {
    return isMaxMessageMissingErrorValue(error);
  }

  async getLogsDashboard(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<LogsDashboardResponse> {
    return this.logsDashboardRuntime.getLogsDashboard(chatId, user, query);
  }

  async getChatActivityFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<MembershipActivityPage> {
    return this.logsDashboardRuntime.getChatActivityFeed(chatId, user, query);
  }

  async getChatModerationFeed(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ModerationFeedPage> {
    return this.logsDashboardRuntime.getChatModerationFeed(chatId, user, query);
  }

  getChatParticipantDetails(chatId: string, targetUserId: string, user: AuthUser, query: unknown) {
    return this.participantsRuntime.getChatParticipantDetails(chatId, targetUserId, user, query);
  }

  async getChatParticipantsPage(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ChatParticipantsPage> {
    return this.participantsRuntime.getChatParticipantsPage(chatId, user, query);
  }

  async updateChatParticipantImmunity(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ChatParticipantImmunityUpdateResult> {
    return this.participantsRuntime.updateChatParticipantImmunity(
      chatId,
      targetUserIdRaw,
      user,
      body,
    );
  }

  async cleanupUnavailableChatParticipants(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ChatUnavailableParticipantsCleanupResult> {
    return this.participantsRuntime.cleanupUnavailableChatParticipants(chatId, user, body);
  }

  async resolveParticipantCleanupBotAssignment(chatId: string): Promise<string | undefined> {
    return this.resolveManualModerationActionBotAssignment(chatId, 'moderate_member');
  }

  async applyManualModerationAction(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    options: ManualModerationExecutionOptions = {},
  ): Promise<ManualModerationActionResult> {
    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user, {
      skipActorAdminCheck: options.actorAlreadyVerified === true,
    });
    const parsed = manualModerationActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const actionRequest = parsed.data;
    // FLAG: Channel bans are local-only and must not inherit chat moderation side effects.
    assertChannelMemberBanScope(options.entityType, actionRequest);
    const sourceLedgerRootKey = this.readTrimmedString(options.fanoutLedgerJobId);
    if (
      sourceLedgerRootKey &&
      (actionRequest.action === 'MUTE' || actionRequest.action === 'BAN')
    ) {
      const operation =
        actionRequest.action === 'MUTE' ? 'COMMAND_SOURCE_MUTE' : 'COMMAND_SOURCE_BAN';
      const sourceLedger = await this.readManualModerationFanoutIntentRow({
        rootIntentKey: sourceLedgerRootKey,
        operation,
        sourceChatId: chatId,
        targetChatId: chatId,
        targetUserId,
      });
      if (sourceLedger?.status === PrismaManualModerationFanoutLedgerStatus.SUCCEEDED) {
        if (sourceLedger.moderationEventId) {
          options.onModerationEventRecorded?.(sourceLedger.moderationEventId);
        }
        if (actionRequest.action === 'MUTE') {
          const mutePermanent = actionRequest.mutePermanent === true;
          const muteDurationHours = actionRequest.muteDurationHours ?? null;
          return this.resolveManualMuteResultFromLedger(sourceLedger, {
            userId: targetUserId,
            muteDurationHours,
            muteExpiresAt:
              !mutePermanent && muteDurationHours
                ? new Date(Date.now() + muteDurationHours * ONE_HOUR_MS)
                : null,
            mutePermanent,
          });
        }
        return this.resolveManualBanResultFromLedger(sourceLedger, targetUserId);
      }
    }
    const localUnban =
      actionRequest.action === 'UNBAN' &&
      (await readLocalChatBanForRelease(
        this.prisma,
        this.moderationSanctionStateFence,
        chatId,
        targetUserId,
      ));
    if (localUnban)
      options = {
        ...options,
        expectedSanctionEventId: options.expectedSanctionEventId ?? localUnban.id,
      };
    const resolvedBotId =
      actionRequest.action === 'UNMUTE' || localUnban
        ? undefined
        : await this.resolveManualModerationActionBotAssignment(
            chatId,
            this.resolveManualModerationBotAction(actionRequest.action),
            {
              preferredBotId: options.preferredBotId,
              entityType: options.entityType,
            },
          );
    const targetDisplayName =
      normalizeMaxUserDisplayName(options.targetDisplayNameHint, targetUserId) ??
      (await this.resolveManualModerationTargetDisplayName(chatId, targetUserId, {
        botId: resolvedBotId,
        allowRemoteLookup:
          options.allowTargetDisplayNameRemoteLookup ??
          (actionRequest.action !== 'UNBAN' && actionRequest.action !== 'UNMUTE'),
      }));

    let memberMutationConfirmed = false;
    try {
      return await this.moderationSanctionStateLock.runExclusive(
        { chatId, userId: targetUserId },
        (leaseGuard) =>
          this.applyManualModerationActionLocked(
            chatId,
            targetUserId,
            user,
            actionRequest,
            resolvedBotId,
            targetDisplayName,
            source,
            options,
            leaseGuard,
            () => {
              memberMutationConfirmed = true;
            },
          ),
      );
    } catch (error: unknown) {
      throw memberMutationConfirmed ? markMaxMemberMutationConfirmed(error) : error;
    }
  }

  private async applyManualModerationActionLocked(
    chatId: string,
    targetUserId: string,
    user: AuthUser,
    actionRequest: ManualModerationActionRequest,
    resolvedBotId: string | undefined,
    targetDisplayName: string | null,
    source: AdminActionSource,
    options: ManualModerationExecutionOptions,
    leaseGuard: ModerationSanctionStateLeaseGuard,
    onMemberMutationConfirmed: () => void,
  ): Promise<ManualModerationActionResult> {
    const isChannel = options.entityType === ChatEntityType.CHANNEL;
    const expectedSanctionEventId = this.readTrimmedString(options.expectedSanctionEventId);
    await this.assertExpectedManualModerationSanctionState({
      chatId,
      targetUserId,
      releaseAction: actionRequest.action,
      expectedSanctionEventId,
    });
    const sourceLedgerRootKey = this.readTrimmedString(options.fanoutLedgerJobId);

    const releasedSanctionMetadata = expectedSanctionEventId
      ? { releasedSanctionEventId: expectedSanctionEventId }
      : {};
    const metadataBase = {
      source,
      initiatedByUserId: user.userId,
      ...releasedSanctionMetadata,
    } as const;
    const applyLocalBan = (action: 'BAN' | 'UNBAN', metadata: Record<string, unknown> = {}) =>
      applyFormerParticipantModeration(
        action,
        targetUserId,
        {
          leaseGuard,
          prepare: (intendedAction) =>
            this.prepareManualSanctionStateFence({
              chatId,
              targetUserId,
              intendedAction,
              source,
              leaseGuard,
            }),
          record: (localAction, localMetadata) =>
            this.recordManualModerationAction({
              chatId,
              targetUserId,
              targetDisplayName,
              actorUserId: user.userId,
              ruleCode: localAction === 'BAN' ? 'MANUAL_BAN' : 'MANUAL_UNBAN',
              sanctionAction: localAction === 'BAN' ? SanctionAction.BAN : SanctionAction.NONE,
              auditAction: localAction === 'BAN' ? 'MANUAL_BAN_MEMBER' : 'MANUAL_UNBAN_MEMBER',
              metadata: { ...metadataBase, ...localMetadata },
              auditPayload: { userId: targetUserId, ...metadataBase, ...localMetadata },
            }),
          commit: this.commitManualSanctionStateFence.bind(this),
          abort: this.abortManualSanctionStateFence.bind(this),
          onRecorded: options.onModerationEventRecorded,
        },
        metadata,
      );
    // FLAG: Local release precedes experimental/native unban paths: removing a
    // return ban must never add or remove a participant in MAX.
    if (
      actionRequest.action === 'UNBAN' &&
      (await readLocalChatBanForRelease(
        this.prisma,
        this.moderationSanctionStateFence,
        chatId,
        targetUserId,
      ))
    ) {
      return applyLocalBan('UNBAN');
    }
    const requestedScope =
      actionRequest.scope ??
      (source === 'miniapp' && actionRequest.action === 'BAN' ? 'all_chats' : 'current_chat');
    const shouldFanoutManualAction = requestedScope === 'all_chats';
    const shouldFanoutCommandMute =
      shouldFanoutManualAction && (source === 'group_command' || source === 'private_command');
    const shouldFanoutMiniappMute = source === 'miniapp' && shouldFanoutManualAction;

    if (actionRequest.action === 'MUTE') {
      const mutePermanent = actionRequest.mutePermanent === true;
      const muteDurationHours = actionRequest.muteDurationHours ?? null;
      if (!mutePermanent && !muteDurationHours) {
        throw new BadRequestException('Укажите длительность мута в часах.');
      }
      const muteExpiresAt = mutePermanent
        ? null
        : new Date(Date.now() + muteDurationHours! * ONE_HOUR_MS);
      let sourceMuteLedgerOperationKey: string | null = null;
      let sourceMuteLedgerLockToken: string | null = null;
      const sourceMuteLedgerMetadata = {
        source,
        muteDurationHours,
        muteExpiresAt: muteExpiresAt ? muteExpiresAt.toISOString() : null,
        mutePermanent,
      } satisfies Prisma.InputJsonObject;
      const existingSourceMuteLedger = sourceLedgerRootKey
        ? await this.readManualModerationFanoutIntentRow({
            rootIntentKey: sourceLedgerRootKey,
            operation: 'COMMAND_SOURCE_MUTE',
            sourceChatId: chatId,
            targetChatId: chatId,
            targetUserId,
          })
        : null;
      if (
        existingSourceMuteLedger &&
        existingSourceMuteLedger.status !==
          PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE &&
        existingSourceMuteLedger.status !== PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS
      ) {
        const existingClaim =
          this.buildExistingManualModerationFanoutLedgerClaim(existingSourceMuteLedger);
        if (!this.isSucceededManualModerationFanoutLedgerClaim(existingClaim)) {
          this.throwManualModerationFanoutLedgerClaimBlocked(existingClaim, 'мут');
        }
        if (existingSourceMuteLedger.moderationEventId) {
          options.onModerationEventRecorded?.(existingSourceMuteLedger.moderationEventId);
        }
        return this.resolveManualMuteResultFromLedger(existingSourceMuteLedger, {
          userId: targetUserId,
          muteDurationHours,
          muteExpiresAt,
          mutePermanent,
        });
      }

      await this.assertManualMemberModerationPreconditions(
        chatId,
        targetUserId,
        'MUTE',
        resolvedBotId,
        source === 'miniapp' && !isChannel,
      );
      if (sourceLedgerRootKey) {
        sourceMuteLedgerOperationKey =
          existingSourceMuteLedger?.operationKey ??
          this.buildManualModerationFanoutOperationKey({
            operation: 'COMMAND_SOURCE_MUTE',
            sourceChatId: chatId,
            targetChatId: chatId,
            targetUserId,
            rootIntentKey: sourceLedgerRootKey,
            extra: [mutePermanent ? 'permanent' : 'timed', mutePermanent ? '' : muteDurationHours],
          });
        const claim = await this.claimManualModerationFanoutLedgerEntry({
          operationKey: sourceMuteLedgerOperationKey,
          rootIntentKey: sourceLedgerRootKey,
          sourceKind: source,
          operation: 'COMMAND_SOURCE_MUTE',
          sourceChatId: chatId,
          targetChatId: chatId,
          targetUserId,
          actorUserId: user.userId,
          logicalAction: 'MUTE',
          botId: resolvedBotId ?? null,
          metadata: sourceMuteLedgerMetadata,
        });
        if (!claim.claimed) {
          if (!this.isSucceededManualModerationFanoutLedgerClaim(claim)) {
            this.throwManualModerationFanoutLedgerClaimBlocked(claim, 'мут');
          }
          if (claim.row?.moderationEventId) {
            options.onModerationEventRecorded?.(claim.row.moderationEventId);
          }
          return this.resolveManualMuteResultFromLedger(claim.row!, {
            userId: targetUserId,
            muteDurationHours,
            muteExpiresAt,
            mutePermanent,
          });
        }
        sourceMuteLedgerLockToken = claim.lockToken;
      }
      try {
        const { sourceMessageCleanup, crossChatMuteFanout } =
          shouldFanoutCommandMute || shouldFanoutMiniappMute
            ? await this.resolveManualMuteCommandFollowUpSummaries({
                sourceChatId: chatId,
                targetUserId,
                actor: user,
                rootIntentKey: options.fanoutLedgerJobId ?? null,
                botId: resolvedBotId ?? null,
                muteDurationHours,
                muteExpiresAt,
                mutePermanent,
                source: source as ManualModerationFanoutSource,
                leaseGuard,
              })
            : {
                sourceMessageCleanup: this.summarizeManualModerationCleanup({
                  candidateMessageIds: [],
                  deletedMessageIds: [],
                  pendingMessageIds: [],
                  failedMessageIds: [],
                }),
                crossChatMuteFanout: this.summarizeManualMuteFanout({
                  mutedChatIds: [],
                  skippedChatIds: [],
                  failedChatIds: [],
                }),
              };

        const sanctionFence = await this.prepareManualSanctionStateFence({
          chatId,
          targetUserId,
          intendedAction: 'MUTE',
          source,
          leaseGuard,
        });
        let moderationEventId: string;
        try {
          await leaseGuard.assertOwned();
          moderationEventId = await this.recordManualModerationAction({
            chatId,
            targetUserId,
            targetDisplayName,
            actorUserId: user.userId,
            ruleCode: 'MANUAL_MUTE',
            sanctionAction: SanctionAction.MUTE,
            auditAction: 'MANUAL_MUTE_MEMBER',
            metadata: {
              ...metadataBase,
              scope: requestedScope,
              reason: `Ручной мут участника ${this.describeManualModerationActionSource(source)}`,
              ...this.buildManualMuteMetadataFields({
                muteDurationHours,
                muteExpiresAt,
                mutePermanent,
              }),
              ...(shouldFanoutCommandMute || shouldFanoutMiniappMute
                ? {
                    sourceMessageCleanup,
                    crossChatMuteFanout,
                  }
                : {}),
            },
            auditPayload: {
              userId: targetUserId,
              source,
              scope: requestedScope,
              ...this.buildManualMuteMetadataFields({
                muteDurationHours,
                muteExpiresAt,
                mutePermanent,
              }),
              ...(shouldFanoutCommandMute || shouldFanoutMiniappMute
                ? {
                    sourceMessageCleanup,
                    crossChatMuteFanout,
                  }
                : {}),
            },
            ...(sourceMuteLedgerOperationKey && sourceMuteLedgerLockToken
              ? {
                  fanoutLedger: {
                    operationKey: sourceMuteLedgerOperationKey,
                    lockToken: sourceMuteLedgerLockToken,
                    botId: resolvedBotId ?? null,
                    metadata: sourceMuteLedgerMetadata,
                  },
                }
              : {}),
          });
        } catch (error: unknown) {
          await this.abortManualSanctionStateFence(sanctionFence);
          throw error;
        }
        await this.commitManualSanctionStateFence(sanctionFence, moderationEventId);
        options.onModerationEventRecorded?.(moderationEventId);

        return manualModerationActionResultSchema.parse({
          ok: true,
          action: 'MUTE',
          userId: targetUserId,
          muteDurationHours,
          muteExpiresAt: muteExpiresAt ? muteExpiresAt.toISOString() : null,
          message: mutePermanent
            ? 'Мут включён без срока.'
            : `Мут включён на ${muteDurationHours} ч.`,
        });
      } catch (error: unknown) {
        if (sourceMuteLedgerOperationKey && sourceMuteLedgerLockToken) {
          await this.markManualModerationFanoutLedgerFailed({
            operationKey: sourceMuteLedgerOperationKey,
            lockToken: sourceMuteLedgerLockToken,
            status: PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
            error,
            botId: resolvedBotId ?? null,
            metadata: sourceMuteLedgerMetadata,
          });
        }
        throw error;
      }
    }

    if (actionRequest.action === 'BAN') {
      const existingSourceBanLedger = sourceLedgerRootKey
        ? await this.readManualModerationFanoutIntentRow({
            rootIntentKey: sourceLedgerRootKey,
            operation: 'COMMAND_SOURCE_BAN',
            sourceChatId: chatId,
            targetChatId: chatId,
            targetUserId,
          })
        : null;
      if (
        existingSourceBanLedger &&
        existingSourceBanLedger.status !==
          PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE &&
        existingSourceBanLedger.status !== PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS
      ) {
        const existingClaim =
          this.buildExistingManualModerationFanoutLedgerClaim(existingSourceBanLedger);
        if (!this.isSucceededManualModerationFanoutLedgerClaim(existingClaim)) {
          this.throwManualModerationFanoutLedgerClaimBlocked(existingClaim, 'бан');
        }
        if (existingSourceBanLedger.moderationEventId) {
          options.onModerationEventRecorded?.(existingSourceBanLedger.moderationEventId);
        }
        const replayExecutionMode =
          this.resolveManualBanExecutionModeFromLedger(existingSourceBanLedger);
        return manualModerationActionResultSchema.parse({
          ok: true,
          action: 'BAN',
          userId: targetUserId,
          muteDurationHours: null,
          muteExpiresAt: null,
          message:
            replayExecutionMode === 'MAX_REMOVE_ONLY' ? 'Участник удалён из чата.' : 'Бан включён.',
        });
      }
      let executionMode: ManualBanExecutionMode;
      try {
        const targetState = await this.assertManualMemberModerationPreconditions(
          chatId,
          targetUserId,
          'BAN',
          resolvedBotId,
          source === 'miniapp' && !isChannel,
        );
        if (targetState === 'former') {
          const followUp = shouldFanoutManualAction
            ? await this.resolveManualBanFollowUpSummaries({
                sourceChatId: chatId,
                targetUserId,
                actor: user,
                source: 'miniapp',
                leaseGuard,
              })
            : {};
          return applyLocalBan('BAN', { scope: requestedScope, ...followUp });
        }
        executionMode = await this.resolveManualBanExecutionMode(chatId, resolvedBotId);
      } catch (error: unknown) {
        this.throwManualModerationTransientMaxError(error);
        throw error;
      }
      let sourceBanLedgerOperationKey: string | null = null;
      let sourceBanLedgerLockToken: string | null = null;
      const sourceBanLedgerMetadata = {
        source,
        executionMode,
      } satisfies Prisma.InputJsonObject;
      if (sourceLedgerRootKey) {
        sourceBanLedgerOperationKey =
          existingSourceBanLedger?.operationKey ??
          this.buildManualModerationFanoutOperationKey({
            operation: 'COMMAND_SOURCE_BAN',
            sourceChatId: chatId,
            targetChatId: chatId,
            targetUserId,
            rootIntentKey: sourceLedgerRootKey,
          });
        const claim = await this.claimManualModerationFanoutLedgerEntry({
          operationKey: sourceBanLedgerOperationKey,
          rootIntentKey: sourceLedgerRootKey,
          sourceKind: source,
          operation: 'COMMAND_SOURCE_BAN',
          sourceChatId: chatId,
          targetChatId: chatId,
          targetUserId,
          actorUserId: user.userId,
          logicalAction: 'BAN',
          botId: resolvedBotId ?? null,
          executionMode,
          metadata: sourceBanLedgerMetadata,
        });
        if (!claim.claimed) {
          if (!this.isSucceededManualModerationFanoutLedgerClaim(claim)) {
            this.throwManualModerationFanoutLedgerClaimBlocked(claim, 'бан');
          }
          if (claim.row?.moderationEventId) {
            options.onModerationEventRecorded?.(claim.row.moderationEventId);
          }
          const replayExecutionMode = this.resolveManualBanExecutionModeFromLedger(
            claim.row!,
            executionMode,
          );
          return manualModerationActionResultSchema.parse({
            ok: true,
            action: 'BAN',
            userId: targetUserId,
            muteDurationHours: null,
            muteExpiresAt: null,
            message:
              replayExecutionMode === 'MAX_REMOVE_ONLY'
                ? 'Участник удалён из чата.'
                : 'Бан включён.',
          });
        }
        sourceBanLedgerLockToken = claim.lockToken;
      }

      let sanctionFence: ModerationSanctionStateFence;
      try {
        sanctionFence = await this.prepareManualSanctionStateFence({
          chatId,
          targetUserId,
          intendedAction: 'BAN',
          source,
          leaseGuard,
        });
      } catch (error: unknown) {
        if (sourceBanLedgerOperationKey && sourceBanLedgerLockToken) {
          await this.markManualModerationFanoutLedgerFailed({
            operationKey: sourceBanLedgerOperationKey,
            lockToken: sourceBanLedgerLockToken,
            status: PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
            error,
            botId: resolvedBotId ?? null,
            executionMode,
            metadata: sourceBanLedgerMetadata,
          });
        }
        throw error;
      }
      let remoteActionConfirmed = false;
      try {
        await leaseGuard.assertOwned();
        try {
          if (resolvedBotId) {
            await this.maxClient.cancelScheduledUnban(chatId, targetUserId, {
              botId: resolvedBotId,
            });
          } else {
            await this.maxClient.cancelScheduledUnban(chatId, targetUserId);
          }
        } catch (cancelError: unknown) {
          this.logger.warn(
            {
              chatId,
              userId: targetUserId,
              err: cancelError instanceof Error ? cancelError.message : String(cancelError),
            },
            'Failed to cancel scheduled auto-unban before manual ban',
          );
        }

        if (sourceBanLedgerOperationKey && sourceBanLedgerLockToken) {
          await leaseGuard.assertOwned();
          await this.markManualModerationFanoutLedgerFailed({
            operationKey: sourceBanLedgerOperationKey,
            lockToken: sourceBanLedgerLockToken,
            status: PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS,
            error: new Error(
              'manual source ban member action started; outcome unknown until confirmed',
            ),
            botId: resolvedBotId ?? null,
            executionMode,
            metadata: {
              ...sourceBanLedgerMetadata,
              actionStartedAt: new Date().toISOString(),
            },
            retainClaim: true,
            requireClaim: true,
          });
        }
        await leaseGuard.assertOwned();
        if (executionMode === 'MAX_REMOVE_ONLY') {
          await this.maxClient.kickMember(chatId, targetUserId, {
            immediate: true,
            beforeImmediateMemberMutation: () => leaseGuard.assertOwned(),
            ...(resolvedBotId ? { botId: resolvedBotId } : {}),
          });
        } else {
          await this.maxClient.banMember(chatId, targetUserId, {
            immediate: true,
            beforeImmediateMemberMutation: () => leaseGuard.assertOwned(),
            ...(resolvedBotId ? { botId: resolvedBotId } : {}),
          });
        }
        remoteActionConfirmed = true;
        onMemberMutationConfirmed();
      } catch (error: unknown) {
        remoteActionConfirmed ||= wasMaxMemberMutationConfirmed(error);
        const remoteOutcomeAmbiguous = this.isAmbiguousAttemptedMaxMemberMutation(error);
        if (remoteActionConfirmed) {
          onMemberMutationConfirmed();
          await this.markManualSanctionStateFenceRemoteConfirmedEventMissing(sanctionFence);
        } else if (!remoteOutcomeAmbiguous) {
          await this.abortManualSanctionStateFence(sanctionFence);
        }
        if (sourceBanLedgerOperationKey && sourceBanLedgerLockToken) {
          await this.markManualModerationFanoutLedgerFailed({
            operationKey: sourceBanLedgerOperationKey,
            lockToken: sourceBanLedgerLockToken,
            status: this.resolveManualModerationOrderingFailureLedgerStatus(error),
            error,
            botId: resolvedBotId ?? null,
            executionMode,
            metadata: sourceBanLedgerMetadata,
          });
        }
        if (this.isManualModerationOrderingFailure(error)) {
          throw error;
        }
        this.throwManualModerationTransientMaxError(error);
        const resolvedMessage = await this.resolveManualMemberModerationErrorMessage(
          chatId,
          targetUserId,
          'BAN',
          error,
          resolvedBotId,
        );
        throw this.preserveMemberMutationOutcome(
          error,
          new BadRequestException(
            resolvedMessage || 'Бан не применён. Проверьте права бота и статус участника.',
          ),
        );
      }

      let moderationEventId: string;
      try {
        await leaseGuard.assertOwned();
        if (!isChannel) {
          await this.deleteAdminGlobalSpammerExemption(user.userId, targetUserId);
          await leaseGuard.assertOwned();
          await this.globalSpammerIntelligence?.recordManualBanObservation({
            chatId,
            targetUserId,
            actorUserId: user.userId,
            source,
            executionMode,
          });
        }
        await leaseGuard.assertOwned();
        const shouldFanoutMiniappBan = source === 'miniapp' && shouldFanoutManualAction;
        const { sourceMessageCleanup, crossChatFanout } = shouldFanoutMiniappBan
          ? await this.resolveManualBanFollowUpSummaries({
              sourceChatId: chatId,
              targetUserId,
              actor: user,
              source,
              leaseGuard,
            })
          : source === 'miniapp' && !isChannel
            ? {
                sourceMessageCleanup: await this.resolveManualBanSourceCleanupSummary({
                  sourceChatId: chatId,
                  targetUserId,
                  actor: user,
                  source,
                  botId: resolvedBotId,
                  leaseGuard,
                }),
                crossChatFanout: this.summarizeManualBanFanout({
                  removedChatIds: [],
                  skippedChatIds: [],
                  failedChatIds: [],
                  deletedMessageCount: 0,
                  failedMessageDeleteCount: 0,
                }),
              }
            : {
                sourceMessageCleanup: this.summarizeManualModerationCleanup({
                  candidateMessageIds: [],
                  deletedMessageIds: [],
                  pendingMessageIds: [],
                  failedMessageIds: [],
                }),
                crossChatFanout: this.summarizeManualBanFanout({
                  removedChatIds: [],
                  skippedChatIds: [],
                  failedChatIds: [],
                  deletedMessageCount: 0,
                  failedMessageDeleteCount: 0,
                }),
              };

        await leaseGuard.assertOwned();
        moderationEventId = await this.recordManualModerationAction({
          chatId,
          targetUserId,
          targetDisplayName,
          actorUserId: user.userId,
          ruleCode: 'MANUAL_BAN',
          sanctionAction: SanctionAction.BAN,
          auditAction: 'MANUAL_BAN_MEMBER',
          metadata: {
            ...metadataBase,
            scope: requestedScope,
            reason: `Ручной бан участника ${this.describeManualModerationActionSource(source)}`,
            mode: executionMode,
            permanent: true,
            ...(source === 'miniapp'
              ? {
                  sourceMessageCleanup,
                  crossChatFanout,
                }
              : {}),
          },
          auditPayload: {
            userId: targetUserId,
            source,
            scope: requestedScope,
            mode: executionMode,
            permanent: true,
            ...(source === 'miniapp'
              ? {
                  sourceMessageCleanup,
                  crossChatFanout,
                }
              : {}),
          },
          ...(sourceBanLedgerOperationKey && sourceBanLedgerLockToken
            ? {
                fanoutLedger: {
                  operationKey: sourceBanLedgerOperationKey,
                  lockToken: sourceBanLedgerLockToken,
                  botId: resolvedBotId ?? null,
                  executionMode,
                  metadata: sourceBanLedgerMetadata,
                },
              }
            : {}),
        });
      } catch (error: unknown) {
        await this.markManualSanctionStateFenceRemoteConfirmedEventMissing(sanctionFence);
        throw markMaxMemberMutationConfirmed(error);
      }
      try {
        await this.commitManualSanctionStateFence(sanctionFence, moderationEventId);
        options.onModerationEventRecorded?.(moderationEventId);
        await leaseGuard.assertOwned();
        if (!isChannel) {
          await sendManualBanChatNotice(this.maxClient, this.logger, {
            chatId,
            targetUserId,
            sanctionEventId: moderationEventId,
            targetDisplayName,
            source,
            removedOnly: executionMode === 'MAX_REMOVE_ONLY',
            botId: resolvedBotId,
          });
        }
        return manualModerationActionResultSchema.parse({
          ok: true,
          action: 'BAN',
          userId: targetUserId,
          muteDurationHours: null,
          muteExpiresAt: null,
          message: describeManualBanResult(executionMode, isChannel),
        });
      } catch (error: unknown) {
        throw markMaxMemberMutationConfirmed(error);
      }
    }

    if (actionRequest.action === 'UNMUTE') {
      const sanctionFence = await this.prepareManualSanctionStateFence({
        chatId,
        targetUserId,
        intendedAction: 'UNMUTE',
        source,
        leaseGuard,
      });
      let moderationEventId: string;
      try {
        await leaseGuard.assertOwned();
        await this.resetDuplicateModerationState(chatId, targetUserId);

        await leaseGuard.assertOwned();
        moderationEventId = await this.recordManualModerationAction({
          chatId,
          targetUserId,
          targetDisplayName,
          actorUserId: user.userId,
          ruleCode: 'MANUAL_UNMUTE',
          sanctionAction: SanctionAction.NONE,
          auditAction: 'MANUAL_UNMUTE_MEMBER',
          metadata: {
            ...metadataBase,
            reason: `Ручное снятие мута участника ${this.describeManualModerationActionSource(source)}`,
          },
          auditPayload: {
            userId: targetUserId,
            source,
            ...releasedSanctionMetadata,
          },
        });
      } catch (error: unknown) {
        await this.abortManualSanctionStateFence(sanctionFence);
        throw error;
      }
      await this.commitManualSanctionStateFence(sanctionFence, moderationEventId);

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'UNMUTE',
        userId: targetUserId,
        muteDurationHours: null,
        muteExpiresAt: null,
        message: 'Мут снят. Автоматическое удаление новых сообщений остановлено.',
      });
    }

    const unbanAttempt = await attemptManualMemberUnban(
      { chatId, targetUserId, actorUserId: user.userId, source, options, botId: resolvedBotId },
      this.maxClient,
      leaseGuard,
      this.assertExpectedManualModerationSanctionState.bind(this),
      this.assertBotCanManageMembers.bind(this),
      actionRequest.action,
    );
    if (unbanAttempt) return unbanAttempt;

    const sanctionFence = await this.prepareManualSanctionStateFence({
      chatId,
      targetUserId,
      intendedAction: 'UNBAN',
      source,
      leaseGuard,
    });
    let unbanMode: ManualUnbanExecutionMode;
    let releaseStateConfirmed = false;
    let remoteOutcomeAmbiguous = false;
    try {
      await leaseGuard.assertOwned();
      if (resolvedBotId) {
        await this.maxClient.cancelScheduledUnban(chatId, targetUserId, {
          botId: resolvedBotId,
        });
      } else {
        await this.maxClient.cancelScheduledUnban(chatId, targetUserId);
      }

      unbanMode = await this.resolveManualUnbanExecutionMode(chatId, targetUserId, resolvedBotId);
      if (unbanMode === 'ALREADY_PRESENT') {
        releaseStateConfirmed = true;
        try {
          await leaseGuard.assertOwned();
          await this.clearTerminalBanStateAfterConfirmedUnban(chatId, targetUserId);
        } catch (error: unknown) {
          throw markMaxMemberMutationConfirmed(error);
        }
      } else {
        try {
          await this.assertBotCanManageMembers(chatId, 'UNBAN', resolvedBotId);
        } catch (error: unknown) {
          this.throwManualModerationTransientMaxError(error);
          throw error;
        }
        try {
          await leaseGuard.assertOwned();
          await this.maxClient.unbanMember(chatId, targetUserId, {
            immediate: true,
            beforeImmediateMemberMutation: () => leaseGuard.assertOwned(),
            ...(resolvedBotId ? { botId: resolvedBotId } : {}),
          });
          releaseStateConfirmed = true;
        } catch (error: unknown) {
          if (error instanceof MaxMemberRestoreUnavailableError) {
            throw new BadRequestException({
              code: error.code,
              message: error.message,
              retryable: false,
            });
          }
          const remoteStateConfirmed = wasMaxMemberMutationConfirmed(error);
          if (remoteStateConfirmed) {
            releaseStateConfirmed = true;
          }
          remoteOutcomeAmbiguous = this.isAmbiguousAttemptedMaxMemberMutation(error);
          this.throwManualModerationTransientMaxError(error);
          const maxApiMessage = this.extractMaxApiErrorMessage(error);
          if (!remoteStateConfirmed && this.isAlreadyPresentMemberAddError(maxApiMessage)) {
            unbanMode = 'ALREADY_PRESENT';
            releaseStateConfirmed = true;
          } else {
            const resolvedMessage = await this.resolveManualMemberUnbanErrorMessage(
              chatId,
              targetUserId,
              error,
              resolvedBotId,
            );
            throw new BadRequestException(
              resolvedMessage ||
                'Участника не удалось вернуть в чат: MAX отклонил действие. Проверьте тип чата, статус участника и права бота.',
            );
          }
        }
      }
    } catch (error: unknown) {
      if (releaseStateConfirmed) {
        await this.markManualSanctionStateFenceRemoteConfirmedEventMissing(sanctionFence);
      } else if (!remoteOutcomeAmbiguous) {
        await this.abortManualSanctionStateFence(sanctionFence);
      }
      throw error;
    }

    let moderationEventId: string;
    try {
      await leaseGuard.assertOwned();
      await this.upsertAdminGlobalSpammerExemption(user.userId, targetUserId, chatId);
      await leaseGuard.assertOwned();
      await this.resetDuplicateModerationState(chatId, targetUserId);

      await leaseGuard.assertOwned();
      moderationEventId = await this.recordManualModerationAction({
        chatId,
        targetUserId,
        targetDisplayName,
        actorUserId: user.userId,
        ruleCode: 'MANUAL_UNBAN',
        sanctionAction: SanctionAction.NONE,
        auditAction: 'MANUAL_UNBAN_MEMBER',
        metadata: {
          ...metadataBase,
          reason: `Ручной разбан участника ${this.describeManualModerationActionSource(source)}`,
          mode: unbanMode,
        },
        auditPayload: {
          userId: targetUserId,
          source,
          mode: unbanMode,
          ...releasedSanctionMetadata,
        },
      });
    } catch (error: unknown) {
      await this.markManualSanctionStateFenceRemoteConfirmedEventMissing(sanctionFence);
      throw error;
    }
    await this.commitManualSanctionStateFence(sanctionFence, moderationEventId);

    return manualModerationActionResultSchema.parse({
      ok: true,
      action: 'UNBAN',
      userId: targetUserId,
      muteDurationHours: null,
      muteExpiresAt: null,
      message:
        unbanMode === 'ALREADY_PRESENT'
          ? 'Блокировка снята. Участник уже в чате, добавлять его повторно не понадобилось.'
          : 'Блокировка снята, участник возвращён в чат.',
    });
  }

  private async assertExpectedManualModerationSanctionState(params: {
    chatId: string;
    targetUserId: string;
    releaseAction: 'MUTE' | 'BAN' | 'UNMUTE' | 'UNBAN';
    expectedSanctionEventId: string | null;
  }): Promise<void> {
    const { chatId, targetUserId, releaseAction, expectedSanctionEventId } = params;
    if (!expectedSanctionEventId) {
      return;
    }
    if (releaseAction !== 'UNBAN' && releaseAction !== 'UNMUTE') {
      throw new ModerationSanctionStateChangedError();
    }

    const expectedAction = releaseAction === 'UNBAN' ? SanctionAction.BAN : SanctionAction.MUTE;
    const expectedEvent = await this.prisma.moderationEvent.findUnique({
      where: { id: expectedSanctionEventId },
      select: {
        id: true,
        chatId: true,
        userId: true,
        action: true,
        metadata: true,
        createdAt: true,
      },
    });
    if (
      !expectedEvent ||
      expectedEvent.chatId !== chatId ||
      expectedEvent.userId !== targetUserId ||
      expectedEvent.action !== expectedAction
    ) {
      throw new ModerationSanctionStateChangedError();
    }

    if (expectedAction === SanctionAction.MUTE) {
      const expiry = resolveModerationSanctionExpiry(
        expectedEvent.action,
        expectedEvent.metadata,
        expectedEvent.createdAt,
      );
      if (!expiry.permanent && !(expiry.expiresAt && expiry.expiresAt.getTime() > Date.now())) {
        throw new ModerationSanctionStateChangedError();
      }
    }

    if (
      await this.moderationSanctionStateFence.isSanctionEventInvalidated({
        chatId,
        userId: targetUserId,
        sanctionEventId: expectedSanctionEventId,
        eventCreatedAt: expectedEvent.createdAt,
      })
    ) {
      throw new ModerationSanctionStateChangedError();
    }

    const latestEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId: targetUserId,
        OR: [
          { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
          { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (latestEvent?.id !== expectedSanctionEventId) {
      throw new ModerationSanctionStateChangedError();
    }
  }

  private async resolveActiveBanSanctionEvent(
    chatId: string,
    targetUserId: string,
  ): Promise<{
    id: string;
    executionMode: ManualBanExecutionMode;
  } | null> {
    const latestEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId: targetUserId,
        OR: [
          { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
          { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        action: true,
        metadata: true,
        createdAt: true,
      },
    });
    if (!latestEvent || latestEvent.action !== SanctionAction.BAN) {
      return null;
    }
    if (
      await this.moderationSanctionStateFence.isSanctionEventInvalidated({
        chatId,
        userId: targetUserId,
        sanctionEventId: latestEvent.id,
        eventCreatedAt: latestEvent.createdAt,
      })
    ) {
      return null;
    }
    const metadata = this.readObjectPayloadOrNull(latestEvent.metadata);
    return {
      id: latestEvent.id,
      executionMode: metadata?.mode === 'MAX_REMOVE_ONLY' ? 'MAX_REMOVE_ONLY' : 'MAX_BLOCK',
    };
  }

  private async prepareManualSanctionStateFence(params: {
    chatId: string;
    targetUserId: string;
    intendedAction: ModerationSanctionStateIntendedAction;
    source: string;
    leaseGuard: ModerationSanctionStateLeaseGuard;
  }): Promise<ModerationSanctionStateFence> {
    await params.leaseGuard.assertOwned();
    return this.moderationSanctionStateFence.prepare({
      chatId: params.chatId,
      userId: params.targetUserId,
      intendedAction: params.intendedAction,
      operator: Operator.ADMIN,
      source: params.source,
    });
  }

  private async commitManualSanctionStateFence(
    fence: ModerationSanctionStateFence,
    eventId: string,
  ): Promise<void> {
    try {
      await this.moderationSanctionStateFence.commit(fence, eventId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: fence.chatId,
          targetUserId: fence.userId,
          transitionId: fence.transitionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to append manual moderation sanction fence outcome',
      );
    }
  }

  private async markManualSanctionStateFenceRemoteConfirmedEventMissing(
    fence: ModerationSanctionStateFence,
  ): Promise<void> {
    try {
      await this.moderationSanctionStateFence.markRemoteConfirmedEventMissing(fence);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: fence.chatId,
          targetUserId: fence.userId,
          transitionId: fence.transitionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to append remote-confirmed manual moderation sanction fence outcome',
      );
    }
  }

  private async abortManualSanctionStateFence(fence: ModerationSanctionStateFence): Promise<void> {
    try {
      await this.moderationSanctionStateFence.abort(fence);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: fence.chatId,
          targetUserId: fence.userId,
          transitionId: fence.transitionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to abort manual moderation sanction fence',
      );
    }
  }

  private isManualModerationOrderingFailure(error: unknown): boolean {
    return isManualModerationOrderingFailure(error);
  }

  private isRetryableManualModerationOrderingFailure(error: unknown): boolean {
    if (error instanceof ModerationSanctionStateLockBusyError) {
      return true;
    }
    return (
      (error instanceof ModerationSanctionStateLockUnavailableError ||
        error instanceof ModerationSanctionStateLockLeaseLostError) &&
      !wasMaxMemberMutationAttempted(error) &&
      !wasMaxMemberMutationConfirmed(error)
    );
  }

  private resolveManualModerationOrderingFailureLedgerStatus(
    error: unknown,
  ): PrismaManualModerationFanoutLedgerStatus {
    if (wasMaxMemberMutationConfirmed(error) || this.isAmbiguousAttemptedMaxMemberMutation(error)) {
      return PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS;
    }
    if (this.isRetryableManualModerationOrderingFailure(error)) {
      return PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE;
    }
    return this.isManualModerationOrderingFailure(error)
      ? PrismaManualModerationFanoutLedgerStatus.FAILED_TERMINAL
      : PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE;
  }

  private isAmbiguousAttemptedMaxMemberMutation(error: unknown): boolean {
    return isAmbiguousAttemptedMaxMemberMutation(error);
  }

  private describeManualModerationActionSource(source: AdminActionSource): string {
    switch (source) {
      case 'private_command':
        return 'через команду в личке';
      case 'group_command':
        return 'через команду в чате';
      case 'private_bot':
        return 'через личный бот';
      default:
        return 'через miniapp';
    }
  }

  private buildManualMuteMetadataFields(params: {
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
  }): {
    muteDurationHours: number | null;
    muteExpiresAt: string | null;
    mutePermanent: boolean;
  } {
    return {
      muteDurationHours: params.mutePermanent ? null : params.muteDurationHours,
      muteExpiresAt: params.muteExpiresAt ? params.muteExpiresAt.toISOString() : null,
      mutePermanent: params.mutePermanent,
    };
  }

  async applyManualSystemBan(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    source: Extract<AdminActionSource, 'group_command' | 'private_command'> = 'group_command',
    options: ManualModerationExecutionOptions = {},
  ): Promise<ManualModerationActionResult> {
    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user, {
      skipActorAdminCheck: options.actorAlreadyVerified === true,
    });
    const sourceLedgerRootKey = this.readTrimmedString(options.fanoutLedgerJobId);
    if (sourceLedgerRootKey) {
      const sourceLedger = await this.readManualModerationFanoutIntentRow({
        rootIntentKey: sourceLedgerRootKey,
        operation: 'COMMAND_SOURCE_BAN',
        sourceChatId: chatId,
        targetChatId: chatId,
        targetUserId,
      });
      if (sourceLedger?.status === PrismaManualModerationFanoutLedgerStatus.SUCCEEDED) {
        if (sourceLedger.moderationEventId) {
          options.onModerationEventRecorded?.(sourceLedger.moderationEventId);
        }
        if (
          this.readObjectPayloadOrNull(sourceLedger.metadata)?.alreadyActive === true &&
          options.fanoutAllChats !== true &&
          source !== 'private_command'
        ) {
          options.onAlreadyApplied?.();
        }
        return this.resolveManualBanResultFromLedger(sourceLedger, targetUserId);
      }
    }
    const resolvedBotId = await this.resolveManualModerationActionBotAssignment(
      chatId,
      'moderate_member',
      {
        preferredBotId: options.preferredBotId,
      },
    );
    const targetDisplayName =
      normalizeMaxUserDisplayName(options.targetDisplayNameHint, targetUserId) ??
      (await this.resolveManualModerationTargetDisplayName(chatId, targetUserId, {
        botId: resolvedBotId,
        allowRemoteLookup: options.allowTargetDisplayNameRemoteLookup,
      }));
    let memberMutationConfirmed = false;
    try {
      return await this.moderationSanctionStateLock.runExclusive(
        { chatId, userId: targetUserId },
        (leaseGuard) =>
          this.applyManualSystemBanLocked(
            chatId,
            targetUserId,
            user,
            source,
            options,
            resolvedBotId,
            targetDisplayName,
            leaseGuard,
            () => {
              memberMutationConfirmed = true;
            },
          ),
      );
    } catch (error: unknown) {
      throw memberMutationConfirmed ? markMaxMemberMutationConfirmed(error) : error;
    }
  }

  private async applyManualSystemBanLocked(
    chatId: string,
    targetUserId: string,
    user: AuthUser,
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>,
    options: ManualModerationExecutionOptions,
    resolvedBotId: string | undefined,
    targetDisplayName: string | null,
    leaseGuard: ModerationSanctionStateLeaseGuard,
    onMemberMutationConfirmed: () => void,
  ): Promise<ManualModerationActionResult> {
    const sourceLedgerRootKey = this.readTrimmedString(options.fanoutLedgerJobId);
    const existingSourceBanLedger = sourceLedgerRootKey
      ? await this.readManualModerationFanoutIntentRow({
          rootIntentKey: sourceLedgerRootKey,
          operation: 'COMMAND_SOURCE_BAN',
          sourceChatId: chatId,
          targetChatId: chatId,
          targetUserId,
        })
      : null;
    if (
      existingSourceBanLedger &&
      existingSourceBanLedger.status !==
        PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE &&
      existingSourceBanLedger.status !== PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS
    ) {
      const existingClaim =
        this.buildExistingManualModerationFanoutLedgerClaim(existingSourceBanLedger);
      if (!this.isSucceededManualModerationFanoutLedgerClaim(existingClaim)) {
        this.throwManualModerationFanoutLedgerClaimBlocked(existingClaim, 'бан');
      }
      if (existingSourceBanLedger.moderationEventId) {
        options.onModerationEventRecorded?.(existingSourceBanLedger.moderationEventId);
      }
      if (
        this.readObjectPayloadOrNull(existingSourceBanLedger.metadata)?.alreadyActive === true &&
        options.fanoutAllChats !== true &&
        source !== 'private_command'
      ) {
        options.onAlreadyApplied?.();
      }
      const replayExecutionMode =
        this.resolveManualBanExecutionModeFromLedger(existingSourceBanLedger);
      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'BAN',
        userId: targetUserId,
        muteDurationHours: null,
        muteExpiresAt: null,
        message:
          replayExecutionMode === 'MAX_REMOVE_ONLY' ? 'Участник удалён из чата.' : 'Бан включён.',
      });
    }
    await leaseGuard.assertOwned();
    let activeBan = await this.resolveActiveBanSanctionEvent(chatId, targetUserId);
    if (activeBan) {
      const targetState = await this.resolveConfirmedManualFanoutTargetState(chatId, targetUserId, {
        trafficClass: 'critical',
        bypassCache: true,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
      if (!targetState) {
        throw new ModerationSanctionStateLockUnavailableError({
          chatId,
          userId: targetUserId,
        });
      }
      if (targetState !== 'absent') {
        if (activeBan.executionMode === 'MAX_BLOCK') {
          await leaseGuard.assertOwned();
          await this.clearTerminalBanStateAfterConfirmedUnban(chatId, targetUserId);
        }
        activeBan = null;
      }
    }
    if (activeBan) {
      let activeIntentOperationKey: string | null = null;
      let activeIntentLockToken: string | null = null;
      let shouldRunActiveFollowUp = true;
      if (sourceLedgerRootKey) {
        const operationKey =
          existingSourceBanLedger?.operationKey ??
          this.buildManualModerationFanoutOperationKey({
            operation: 'COMMAND_SOURCE_BAN',
            sourceChatId: chatId,
            targetChatId: chatId,
            targetUserId,
            rootIntentKey: sourceLedgerRootKey,
          });
        const claim = await this.claimManualModerationFanoutLedgerEntry({
          operationKey,
          rootIntentKey: sourceLedgerRootKey,
          sourceKind: source,
          operation: 'COMMAND_SOURCE_BAN',
          sourceChatId: chatId,
          targetChatId: chatId,
          targetUserId,
          actorUserId: user.userId,
          logicalAction: 'BAN',
          botId: resolvedBotId ?? null,
          executionMode: activeBan.executionMode,
          metadata: {
            source,
            executionMode: activeBan.executionMode,
            alreadyActive: true,
          },
        });
        if (!claim.claimed) {
          if (!this.isSucceededManualModerationFanoutLedgerClaim(claim)) {
            this.throwManualModerationFanoutLedgerClaimBlocked(claim, 'бан');
          }
          shouldRunActiveFollowUp = false;
        } else {
          activeIntentOperationKey = operationKey;
          activeIntentLockToken = claim.lockToken;
        }
      }
      try {
        if (
          shouldRunActiveFollowUp &&
          (options.fanoutAllChats === true || source === 'private_command')
        ) {
          await leaseGuard.assertOwned();
          await this.resolveManualBanFollowUpSummaries({
            sourceChatId: chatId,
            targetUserId,
            actor: user,
            source,
            rootIntentKey: options.fanoutLedgerJobId ?? null,
            leaseGuard,
          });
        }
        if (activeIntentOperationKey && activeIntentLockToken) {
          await leaseGuard.assertOwned();
          await this.completeManualModerationFanoutLedgerEntry({
            operationKey: activeIntentOperationKey,
            lockToken: activeIntentLockToken,
            botId: resolvedBotId ?? null,
            executionMode: activeBan.executionMode,
            moderationEventId: activeBan.id,
            metadata: {
              source,
              executionMode: activeBan.executionMode,
              alreadyActive: true,
            },
          });
        }
      } catch (error: unknown) {
        if (activeIntentOperationKey && activeIntentLockToken) {
          await this.markManualModerationFanoutLedgerFailed({
            operationKey: activeIntentOperationKey,
            lockToken: activeIntentLockToken,
            status: PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
            error,
            botId: resolvedBotId ?? null,
            executionMode: activeBan.executionMode,
            metadata: {
              source,
              executionMode: activeBan.executionMode,
              alreadyActive: true,
            },
          });
        }
        throw error;
      }
      options.onModerationEventRecorded?.(activeBan.id);
      if (options.fanoutAllChats !== true && source !== 'private_command') {
        options.onAlreadyApplied?.();
      }
      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'BAN',
        userId: targetUserId,
        muteDurationHours: null,
        muteExpiresAt: null,
        message:
          activeBan.executionMode === 'MAX_REMOVE_ONLY'
            ? 'Участник уже удалён из чата.'
            : 'Бан уже включён.',
      });
    }
    let executionMode: ManualBanExecutionMode = 'MAX_BLOCK';
    try {
      await this.assertManualMemberModerationPreconditions(
        chatId,
        targetUserId,
        'BAN',
        resolvedBotId,
      );
      executionMode = await this.resolveManualBanExecutionMode(chatId, resolvedBotId);
    } catch (error: unknown) {
      this.throwManualModerationTransientMaxError(error);
      throw error;
    }
    let sourceBanLedgerOperationKey: string | null = null;
    let sourceBanLedgerLockToken: string | null = null;
    const sourceBanLedgerMetadata = {
      source,
      executionMode,
    } satisfies Prisma.InputJsonObject;
    if (sourceLedgerRootKey) {
      sourceBanLedgerOperationKey =
        existingSourceBanLedger?.operationKey ??
        this.buildManualModerationFanoutOperationKey({
          operation: 'COMMAND_SOURCE_BAN',
          sourceChatId: chatId,
          targetChatId: chatId,
          targetUserId,
          rootIntentKey: sourceLedgerRootKey,
        });
      const claim = await this.claimManualModerationFanoutLedgerEntry({
        operationKey: sourceBanLedgerOperationKey,
        rootIntentKey: sourceLedgerRootKey,
        sourceKind: source,
        operation: 'COMMAND_SOURCE_BAN',
        sourceChatId: chatId,
        targetChatId: chatId,
        targetUserId,
        actorUserId: user.userId,
        logicalAction: 'BAN',
        botId: resolvedBotId ?? null,
        executionMode,
        metadata: sourceBanLedgerMetadata,
      });
      if (!claim.claimed) {
        if (!this.isSucceededManualModerationFanoutLedgerClaim(claim)) {
          this.throwManualModerationFanoutLedgerClaimBlocked(claim, 'бан');
        }
        if (claim.row?.moderationEventId) {
          options.onModerationEventRecorded?.(claim.row.moderationEventId);
        }
        const replayExecutionMode = this.resolveManualBanExecutionModeFromLedger(
          claim.row!,
          executionMode,
        );
        return manualModerationActionResultSchema.parse({
          ok: true,
          action: 'BAN',
          userId: targetUserId,
          muteDurationHours: null,
          muteExpiresAt: null,
          message:
            replayExecutionMode === 'MAX_REMOVE_ONLY' ? 'Участник удалён из чата.' : 'Бан включён.',
        });
      }
      sourceBanLedgerLockToken = claim.lockToken;
    }

    let sanctionFence: ModerationSanctionStateFence;
    try {
      sanctionFence = await this.prepareManualSanctionStateFence({
        chatId,
        targetUserId,
        intendedAction: 'BAN',
        source,
        leaseGuard,
      });
    } catch (error: unknown) {
      if (sourceBanLedgerOperationKey && sourceBanLedgerLockToken) {
        await this.markManualModerationFanoutLedgerFailed({
          operationKey: sourceBanLedgerOperationKey,
          lockToken: sourceBanLedgerLockToken,
          status: PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
          error,
          botId: resolvedBotId ?? null,
          executionMode,
          metadata: sourceBanLedgerMetadata,
        });
      }
      throw error;
    }

    let remoteActionConfirmed = false;
    try {
      await leaseGuard.assertOwned();
      try {
        if (resolvedBotId) {
          await this.maxClient.cancelScheduledUnban(chatId, targetUserId, {
            botId: resolvedBotId,
          });
        } else {
          await this.maxClient.cancelScheduledUnban(chatId, targetUserId);
        }
      } catch (cancelError: unknown) {
        this.logger.warn(
          {
            chatId,
            userId: targetUserId,
            err: cancelError instanceof Error ? cancelError.message : String(cancelError),
          },
          'Failed to cancel scheduled auto-unban before permanent manual ban',
        );
      }

      if (sourceBanLedgerOperationKey && sourceBanLedgerLockToken) {
        await leaseGuard.assertOwned();
        await this.markManualModerationFanoutLedgerFailed({
          operationKey: sourceBanLedgerOperationKey,
          lockToken: sourceBanLedgerLockToken,
          status: PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS,
          error: new Error(
            'manual source ban member action started; outcome unknown until confirmed',
          ),
          botId: resolvedBotId ?? null,
          executionMode,
          metadata: {
            ...sourceBanLedgerMetadata,
            actionStartedAt: new Date().toISOString(),
          },
          retainClaim: true,
          requireClaim: true,
        });
      }
      await leaseGuard.assertOwned();
      if (executionMode === 'MAX_REMOVE_ONLY') {
        await this.maxClient.kickMember(chatId, targetUserId, {
          immediate: true,
          beforeImmediateMemberMutation: () => leaseGuard.assertOwned(),
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
      } else {
        await this.maxClient.banMember(chatId, targetUserId, {
          immediate: true,
          beforeImmediateMemberMutation: () => leaseGuard.assertOwned(),
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
      }
      remoteActionConfirmed = true;
      onMemberMutationConfirmed();
    } catch (error: unknown) {
      remoteActionConfirmed ||= wasMaxMemberMutationConfirmed(error);
      const remoteOutcomeAmbiguous = this.isAmbiguousAttemptedMaxMemberMutation(error);
      if (remoteActionConfirmed) {
        onMemberMutationConfirmed();
        await this.markManualSanctionStateFenceRemoteConfirmedEventMissing(sanctionFence);
      } else if (!remoteOutcomeAmbiguous) {
        await this.abortManualSanctionStateFence(sanctionFence);
      }
      if (sourceBanLedgerOperationKey && sourceBanLedgerLockToken) {
        await this.markManualModerationFanoutLedgerFailed({
          operationKey: sourceBanLedgerOperationKey,
          lockToken: sourceBanLedgerLockToken,
          status: this.resolveManualModerationOrderingFailureLedgerStatus(error),
          error,
          botId: resolvedBotId ?? null,
          executionMode,
          metadata: sourceBanLedgerMetadata,
        });
      }
      if (this.isManualModerationOrderingFailure(error)) {
        throw error;
      }
      this.throwManualModerationTransientMaxError(error);
      const resolvedMessage = await this.resolveManualMemberModerationErrorMessage(
        chatId,
        targetUserId,
        'BAN',
        error,
        resolvedBotId,
      );
      throw this.preserveMemberMutationOutcome(
        error,
        new BadRequestException(
          resolvedMessage || 'Бан не применён. Проверьте права бота и статус участника.',
        ),
      );
    }

    let moderationEventId: string;
    try {
      await leaseGuard.assertOwned();
      await this.deleteAdminGlobalSpammerExemption(user.userId, targetUserId);
      await leaseGuard.assertOwned();
      await this.globalSpammerIntelligence?.recordManualBanObservation({
        chatId,
        targetUserId,
        actorUserId: user.userId,
        source,
        executionMode,
      });

      await leaseGuard.assertOwned();
      let recentMessageCleanup = this.summarizeManualModerationCleanup({
        candidateMessageIds: [],
        deletedMessageIds: [],
        pendingMessageIds: [],
        failedMessageIds: [],
      });
      let crossChatFanout = this.summarizeManualBanFanout({
        removedChatIds: [],
        skippedChatIds: [],
        failedChatIds: [],
        deletedMessageCount: 0,
        failedMessageDeleteCount: 0,
      });

      if (source === 'group_command' || source === 'private_command') {
        const shouldFanoutBan = options.fanoutAllChats === true || source === 'private_command';
        if (shouldFanoutBan) {
          const followUp = await this.resolveManualBanFollowUpSummaries({
            sourceChatId: chatId,
            targetUserId,
            actor: user,
            source,
            rootIntentKey: options.fanoutLedgerJobId ?? null,
            leaseGuard,
          });
          recentMessageCleanup = followUp.sourceMessageCleanup;
          crossChatFanout = followUp.crossChatFanout;
        } else {
          const queuedCleanup = await this.resolveManualBanSourceCleanupSummary({
            sourceChatId: chatId,
            targetUserId,
            actor: user,
            source,
            rootIntentKey: options.fanoutLedgerJobId ?? null,
            botId: resolvedBotId,
            leaseGuard,
          });
          recentMessageCleanup = queuedCleanup;
        }
      }

      await leaseGuard.assertOwned();
      moderationEventId = await this.recordManualModerationAction({
        chatId,
        targetUserId,
        targetDisplayName,
        actorUserId: user.userId,
        ruleCode: 'MANUAL_BAN',
        sanctionAction: SanctionAction.BAN,
        auditAction: 'MANUAL_BAN_MEMBER',
        metadata: {
          source,
          initiatedByUserId: user.userId,
          reason:
            source === 'group_command'
              ? 'Постоянный ручной бан участника через команду в чате'
              : 'Постоянный ручной бан участника через команду в личке',
          mode: executionMode,
          recentMessageCleanup,
          crossChatFanout,
        },
        auditPayload: {
          userId: targetUserId,
          source,
          permanent: true,
          mode: executionMode,
          recentMessageCleanup,
          crossChatFanout,
        },
        ...(sourceBanLedgerOperationKey && sourceBanLedgerLockToken
          ? {
              fanoutLedger: {
                operationKey: sourceBanLedgerOperationKey,
                lockToken: sourceBanLedgerLockToken,
                botId: resolvedBotId ?? null,
                executionMode,
                metadata: sourceBanLedgerMetadata,
              },
            }
          : {}),
      });
    } catch (error: unknown) {
      await this.markManualSanctionStateFenceRemoteConfirmedEventMissing(sanctionFence);
      throw markMaxMemberMutationConfirmed(error);
    }
    try {
      await this.commitManualSanctionStateFence(sanctionFence, moderationEventId);
      options.onModerationEventRecorded?.(moderationEventId);
      await leaseGuard.assertOwned();
      await sendManualBanChatNotice(this.maxClient, this.logger, {
        chatId,
        targetUserId,
        sanctionEventId: moderationEventId,
        targetDisplayName,
        source,
        removedOnly: executionMode === 'MAX_REMOVE_ONLY',
        botId: resolvedBotId,
      });

      return manualModerationActionResultSchema.parse({
        ok: true,
        action: 'BAN',
        userId: targetUserId,
        muteDurationHours: null,
        muteExpiresAt: null,
        message: executionMode === 'MAX_REMOVE_ONLY' ? 'Участник удалён из чата.' : 'Бан включён.',
      });
    } catch (error: unknown) {
      throw markMaxMemberMutationConfirmed(error);
    }
  }

  async enqueueManualGroupModerationCommand(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    action: 'BAN' | 'MUTE';
    fanoutAllChats?: boolean;
    muteDurationHours?: number | null;
    mutePermanent?: boolean;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): Promise<boolean> {
    return this.manualModerationRuntime.enqueueManualGroupModerationCommand(params);
  }

  async applyManualChatSilenceCommand(
    chatId: string,
    user: AuthUser,
    options: { durationHours?: number | null } = {},
    source: Extract<AdminActionSource, 'group_command'> = 'group_command',
    command?: GroupCommandPermit,
  ): Promise<{
    ok: true;
    message: string;
    durationHours: number;
    until: string;
    skipped?: boolean;
  }> {
    if (!command) throw new BadRequestException('Group command identity is required');
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');
    const durationHours = this.normalizeManualChatSilenceDurationHours(options.durationHours);
    // FLAG: Retries use the original command time, never the worker/replay time.
    const until = new Date(
      command.sourceAt.getTime() + durationHours * 60 * 60 * 1_000,
    ).toISOString();
    const message = `Чат закрыт на ${durationHours} ч. До конца срока сообщения участников без прав администратора будут удаляться.`;
    const result = await applyGroupChatControlCommand(this.prisma, command, {
      chatId,
      actorUserId: user.userId,
      source,
      action: 'SILENCE',
      message,
      settings: {
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: durationHours % 24,
        nightModeForceCloseDays: Math.floor(durationHours / 24),
        nightModeForceCloseUntil: until,
      },
      auditPayload: { durationHours, until },
    });
    command.result = result;
    if (result.applied) {
      await this.chatContextCache.invalidate(chatId);
      this.scheduleDestructiveModerationAdminRosterWarmup(chatId, {
        nightModeEnabled: false,
        nightModeForceCloseEnabled: true,
      });
    }
    return {
      ok: true,
      message,
      durationHours,
      until,
      ...(!result.applied ? { skipped: true } : {}),
    };
  }

  async applyManualOpenChatCommand(
    chatId: string,
    user: AuthUser,
    source: Extract<AdminActionSource, 'group_command'> = 'group_command',
    command?: GroupCommandPermit,
  ): Promise<{ ok: true; message: string; skipped?: boolean }> {
    if (!command) throw new BadRequestException('Group command identity is required');
    await this.assertChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');
    const message = 'Чат открыт. Для сообщений снова действуют обычные правила.';
    const result = await applyGroupChatControlCommand(this.prisma, command, {
      chatId,
      actorUserId: user.userId,
      source,
      action: 'OPEN_CHAT',
      message,
      resolveMessage: (settings) =>
        resolveEffectiveChatClosure(settings).closed
          ? 'Ручное закрытие снято. Чат остаётся закрыт по ночному расписанию.'
          : message,
      settings: {
        nightModeForceCloseEnabled: false,
        nightModeForceCloseForever: false,
        nightModeForceCloseUntil: '',
      },
    });
    command.result = result;
    if (result.applied) await this.chatContextCache.invalidate(chatId);
    return {
      ok: true,
      message: result.noticeText ?? message,
      ...(!result.applied ? { skipped: true } : {}),
    };
  }

  isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
    const normalized = this.readTrimmedString(userId);
    return Boolean(normalized && this.superBanDeveloperUserIds.has(normalized));
  }

  private parseSuperBanDeveloperUserIds(raw: string | null | undefined): ReadonlySet<string> {
    const values = new Set<string>(
      DEFAULT_SUPER_BAN_DEVELOPER_USER_IDS.map((value) => value.trim()).filter(Boolean),
    );
    const configured = this.readTrimmedString(raw);
    if (!configured) {
      return values;
    }

    for (const value of configured.split(/[,\s;]+/u)) {
      const normalized = value.trim();
      if (normalized) {
        values.add(normalized);
      }
    }

    return values;
  }

  async enqueueDeveloperSuperBanCommand(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): Promise<boolean> {
    return this.manualModerationRuntime.enqueueDeveloperSuperBanCommand(params);
  }

  async processDeveloperSuperBanJob(job: AdminSuperBanJob): Promise<void> {
    if (job.kind !== 'developer_super_ban') {
      return;
    }

    if (!this.isSuperBanDeveloperUserId(job.actor.userId)) {
      this.logger.warn(
        {
          jobId: job.jobId,
          sourceChatId: job.sourceChatId,
          actorUserId: job.actor.userId,
          targetUserId: job.targetUserId,
        },
        'Skipped developer super ban job from non-developer actor',
      );
      return;
    }

    if (this.isKnownRuntimeBotUserId(job.targetUserId)) {
      const noticeBotId = await this.resolveManualGroupCommandNoticeBotId(
        job.sourceChatId,
        job.commandBotId,
      );
      await this.sendManualGroupCommandNotice({
        chatId: job.sourceChatId,
        botId: noticeBotId,
        text: 'Команда `супер бан` отклонена: настроенные боты MAX защищены от блокировки.',
        deleteBotMessagesEnabled: job.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: job.deleteBotMessagesDelayMinutes,
      });
      return;
    }

    const actor = this.buildManualFanoutActor(job.actor);
    const targetDisplayName =
      normalizeMaxUserDisplayName(job.targetSenderName, job.targetUserId) ??
      (await this.resolveManualModerationTargetDisplayName(job.sourceChatId, job.targetUserId, {
        botId: job.commandBotId ?? undefined,
        allowRemoteLookup: false,
      }));

    // FLAG: Persist cleanup before any irreversible super-ban side effect. Once these intents
    // exist, their retry loop owns deletion and a later cleanup failure must not replay the ban.
    const cleanupBotId = await this.resolveManualGroupCommandCleanupBotId(
      job.sourceChatId,
      job.commandBotId,
    );
    await this.deleteManualGroupCommandTargetMessage(job, { botId: cleanupBotId });
    await this.deleteManualGroupCommandMessage(job.sourceChatId, job.commandMessageId, {
      botId: cleanupBotId,
      originBotId: job.commandBotId,
      actorUserId: job.actor.userId,
    });

    await this.recordDeveloperForcedGlobalBlacklistForJob(job, targetDisplayName);
    await this.rememberDeveloperForcedGlobalSpammer(job.targetUserId);

    const sourceResult = await this.applyDeveloperSuperBanSourceChat({
      job,
      actor,
      targetDisplayName,
    });
    if (sourceResult.mode === 'removed') {
      await this.runManualBanSourceCleanup(job.sourceChatId, job.targetUserId, actor.userId, {
        logMessage: 'Failed to clean source chat messages after developer super ban',
      });
    }

    const estimatedManagedChatCount = await this.estimateDeveloperSuperBanManagedChatCount({
      sourceChatId: job.sourceChatId,
      actorUserId: actor.userId,
    });
    const targetLabel = formatManualModerationUserLabel(targetDisplayName, job.targetUserId);
    const estimatedChatCount = Math.max(1, estimatedManagedChatCount ?? 1);
    const estimatedChatCountText =
      estimatedChatCount === 1 ? `${estimatedChatCount} чате` : `${estimatedChatCount} чатах`;
    const noticeBotId = await this.resolveManualGroupCommandNoticeBotId(
      job.sourceChatId,
      job.commandBotId,
    );
    await this.sendManualGroupCommandNotice({
      chatId: job.sourceChatId,
      botId: noticeBotId,
      text: `Для пользователя ${targetLabel} включена блокировка в ${estimatedChatCountText} по решению разработчика бота.`,
      deleteBotMessagesEnabled: job.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: job.deleteBotMessagesDelayMinutes,
    });
  }

  private async recordDeveloperForcedGlobalBlacklistForJob(
    job: AdminSuperBanJob,
    targetDisplayName: string | null,
  ): Promise<void> {
    const reason = 'По решению разработчика бота за нарушение правил';
    if (this.globalSpammerIntelligence) {
      await this.globalSpammerIntelligence.recordDeveloperForcedGlobalBlacklist({
        userId: job.targetUserId,
        actorUserId: job.actor.userId,
        chatId: job.sourceChatId,
        messageId: job.targetMessageId ?? job.commandMessageId,
        userLabel: targetDisplayName,
        reason,
      });
      return;
    }

    const expiresAt = new Date(Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC * 1_000);
    await this.prisma.globalSpammer.upsert({
      where: {
        userId: job.targetUserId,
      },
      create: {
        userId: job.targetUserId,
        lastReason: reason,
        lastChatId: job.sourceChatId,
        lastEvidence: {
          actorUserId: job.actor.userId,
          sourceChatId: job.sourceChatId,
          messageId: job.targetMessageId ?? job.commandMessageId,
          reason,
        } as Prisma.InputJsonObject,
        confidenceScore: 1,
        expiresAt,
        sourceBreakdown: {
          DEVELOPER_FORCED: {
            score: 1,
            count: 1,
            reasons: [reason],
          },
        } as Prisma.InputJsonObject,
      },
      update: {
        detectionsCount: {
          increment: 1,
        },
        lastReason: reason,
        lastChatId: job.sourceChatId,
        lastEvidence: {
          actorUserId: job.actor.userId,
          sourceChatId: job.sourceChatId,
          messageId: job.targetMessageId ?? job.commandMessageId,
          reason,
        } as Prisma.InputJsonObject,
        confidenceScore: 1,
        expiresAt,
        sourceBreakdown: {
          DEVELOPER_FORCED: {
            score: 1,
            count: 1,
            reasons: [reason],
          },
        } as Prisma.InputJsonObject,
      },
    });
  }

  private async rememberDeveloperForcedGlobalSpammer(targetUserId: string): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildDeveloperForcedGlobalSpammerCacheKey(targetUserId),
        '1',
        DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to cache developer-forced global spammer state',
      );
    }
  }

  private async estimateDeveloperSuperBanManagedChatCount(params: {
    sourceChatId: string;
    actorUserId: string;
  }): Promise<number | null> {
    try {
      const privateDialogFilter = DEVELOPER_SUPER_BAN_PRIVATE_DIALOG_ID_PREFIXES.length
        ? Prisma.sql`AND NOT (${Prisma.join(
            DEVELOPER_SUPER_BAN_PRIVATE_DIALOG_ID_PREFIXES.map(
              (prefix) => Prisma.sql`c.id LIKE ${`${prefix}%`}`,
            ),
            ' OR ',
          )})`
        : Prisma.empty;
      const rows = await this.prisma.$queryRaw<
        Array<{ active_membership_count: bigint | number | string }>
      >(
        Prisma.sql`
          SELECT COUNT(*) AS active_membership_count
          FROM chat_bot_memberships membership
          JOIN chats c ON c.id = membership.chat_id
          WHERE membership.status = ${ChatBotMembershipStatus.ACTIVE}::"ChatBotMembershipStatus"
            AND c.entity_type = ${ChatEntityType.CHAT}::"ChatEntityType"
            ${privateDialogFilter}
        `,
      );
      const count = Number(rows[0]?.active_membership_count ?? 0);

      return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
    } catch (error: unknown) {
      this.logger.warn(
        {
          sourceChatId: params.sourceChatId,
          actorUserId: params.actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to estimate managed chat count for developer super ban notice',
      );
      return null;
    }
  }

  private async applyDeveloperSuperBanSourceChat(params: {
    job: AdminSuperBanJob;
    actor: AuthUser;
    targetDisplayName: string | null;
  }): Promise<{ affected: boolean; mode: 'removed' | 'muted' | 'skipped' | 'failed' }> {
    const { job, actor, targetDisplayName } = params;
    const commandOptions: ManualModerationExecutionOptions = {
      actorAlreadyVerified: true,
      preferredBotId: job.commandBotId ?? null,
      targetDisplayNameHint: targetDisplayName,
      allowTargetDisplayNameRemoteLookup: false,
    };

    try {
      await this.applyManualModerationAction(
        job.sourceChatId,
        job.targetUserId,
        actor,
        { action: 'BAN' },
        'group_command',
        commandOptions,
      );
      return { affected: true, mode: 'removed' };
    } catch (error: unknown) {
      if (wasMaxMemberMutationConfirmed(error)) {
        this.logger.warn(
          {
            jobId: job.jobId,
            chatId: job.sourceChatId,
            actorUserId: actor.userId,
            targetUserId: job.targetUserId,
            err: this.extractManualGroupCommandErrorMessage(error),
          },
          'Developer super ban source member removal was confirmed but local completion failed; skipping mute fallback',
        );
        return { affected: true, mode: 'removed' };
      }
      if (this.isAmbiguousAttemptedMaxMemberMutation(error)) {
        this.logger.warn(
          {
            jobId: job.jobId,
            chatId: job.sourceChatId,
            actorUserId: actor.userId,
            targetUserId: job.targetUserId,
            err: this.extractManualGroupCommandErrorMessage(error),
          },
          'Developer super ban source member removal outcome is ambiguous; skipping mute fallback',
        );
        return { affected: false, mode: 'failed' };
      }
      this.logger.warn(
        {
          jobId: job.jobId,
          chatId: job.sourceChatId,
          actorUserId: actor.userId,
          targetUserId: job.targetUserId,
          err: this.extractManualGroupCommandErrorMessage(error),
        },
        'Developer super ban source chat system ban failed; trying permanent mute fallback',
      );
    }

    return this.applyDeveloperSuperBanPermanentMuteFallback({
      chatId: job.sourceChatId,
      sourceChatId: job.sourceChatId,
      targetUserId: job.targetUserId,
      targetDisplayName,
      actor,
      preferredBotId: job.commandBotId ?? null,
      fallbackReason: 'SOURCE_SYSTEM_BAN_FAILED',
    });
  }

  private async applyDeveloperSuperBanPermanentMuteFallback(params: {
    chatId: string;
    sourceChatId: string;
    targetUserId: string;
    targetDisplayName: string | null;
    actor: AuthUser;
    preferredBotId?: string | null;
    fallbackReason: string;
  }): Promise<{ affected: boolean; mode: 'muted' | 'skipped' | 'failed' }> {
    const { chatId, sourceChatId, targetUserId, targetDisplayName, actor, fallbackReason } = params;
    let deleteBotId: string | undefined;
    try {
      deleteBotId = await this.resolveManualModerationActionBotAssignment(
        chatId,
        'delete_message',
        {
          preferredBotId: params.preferredBotId,
        },
      );
      await this.assertBotCanDeleteMessages(chatId, deleteBotId);
    } catch (error: unknown) {
      const errorMessage = this.extractHttpErrorMessage(error) || String(error);
      this.logger.warn(
        {
          chatId,
          sourceChatId,
          actorUserId: actor.userId,
          targetUserId,
          err: errorMessage,
        },
        'Developer super ban fallback skipped because the bot cannot delete messages',
      );
      await this.recordDeveloperSuperBanNoRightsChat({
        chatId,
        sourceChatId,
        targetUserId,
        targetDisplayName,
        actor,
        fallbackReason,
        errorMessage,
      });
      return { affected: false, mode: 'failed' };
    }

    try {
      const transition = await this.moderationSanctionStateLock.runExclusive(
        { chatId, userId: targetUserId },
        async (leaseGuard) => {
          const targetState = await this.resolveManualFanoutTargetState(chatId, targetUserId, {
            trafficClass: 'critical',
            ...(deleteBotId ? { botId: deleteBotId } : {}),
          });
          if (targetState !== 'present') {
            return 'skipped' as const;
          }

          const sanctionFence = await this.prepareManualSanctionStateFence({
            chatId,
            targetUserId,
            intendedAction: 'MUTE',
            source: 'developer_super_ban_fallback',
            leaseGuard,
          });
          let moderationEventId: string;
          try {
            await leaseGuard.assertOwned();
            moderationEventId = await this.recordManualModerationAction({
              chatId,
              targetUserId,
              targetDisplayName,
              actorUserId: actor.userId,
              ruleCode: 'MANUAL_MUTE',
              sanctionAction: SanctionAction.MUTE,
              auditAction: 'MANUAL_MUTE_MEMBER',
              metadata: {
                source: 'group_command',
                initiatedByUserId: actor.userId,
                reason: 'Супер бан: постоянное удаление сообщений по решению разработчика бота',
                ...this.buildManualMuteMetadataFields({
                  muteDurationHours: null,
                  muteExpiresAt: null,
                  mutePermanent: true,
                }),
                sourceChatId,
                fanout: chatId !== sourceChatId,
                superBan: true,
                fallbackReason,
              },
              auditPayload: {
                userId: targetUserId,
                source: 'group_command',
                ...this.buildManualMuteMetadataFields({
                  muteDurationHours: null,
                  muteExpiresAt: null,
                  mutePermanent: true,
                }),
                sourceChatId,
                fanout: chatId !== sourceChatId,
                superBan: true,
                fallbackReason,
              },
            });
          } catch (error: unknown) {
            await this.abortManualSanctionStateFence(sanctionFence);
            throw error;
          }
          await this.commitManualSanctionStateFence(sanctionFence, moderationEventId);
          await leaseGuard.assertOwned();
          await this.deleteRecentTrackedMessagesForManualAction(chatId, targetUserId, {
            spacingMs: this.manualFanoutActionSpacingMs,
            botId: deleteBotId,
            leaseGuard,
          });
          return 'muted' as const;
        },
      );
      if (transition === 'skipped') {
        return { affected: false, mode: 'skipped' };
      }

      return { affected: true, mode: 'muted' };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          sourceChatId,
          actorUserId: actor.userId,
          targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to apply developer super ban permanent mute fallback',
      );
      return { affected: false, mode: 'failed' };
    }
  }

  private async recordDeveloperSuperBanNoRightsChat(params: {
    chatId: string;
    sourceChatId: string;
    targetUserId: string;
    targetDisplayName: string | null;
    actor: AuthUser;
    fallbackReason: string;
    errorMessage: string;
  }): Promise<void> {
    const targetDisplayName = this.readTrimmedString(params.targetDisplayName);
    try {
      await this.prisma.moderationEvent.create({
        data: {
          chatId: params.chatId,
          userId: params.targetUserId,
          eventType: EventType.MEMBER_ACTION,
          ruleCode: 'SUPER_BAN_NO_RIGHTS',
          action: SanctionAction.NONE,
          operator: Operator.ADMIN,
          metadata: {
            source: 'group_command',
            initiatedByUserId: params.actor.userId,
            reason: 'Супер бан: у бота нет прав исключать участника или удалять его сообщения',
            sourceChatId: params.sourceChatId,
            fanout: params.chatId !== params.sourceChatId,
            superBan: true,
            noRights: true,
            fallbackReason: params.fallbackReason,
            errorMessage: params.errorMessage,
            ...(targetDisplayName ? { targetDisplayName } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          sourceChatId: params.sourceChatId,
          actorUserId: params.actor.userId,
          targetUserId: params.targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record developer super ban no-rights chat',
      );
    }
  }

  async processManualModerationFanoutJob(job: AdminManualFanoutJob): Promise<void> {
    return this.manualModerationRuntime.processManualModerationFanoutJob(job);
  }

  private isRetryableManualFanoutPreparationError(error: unknown): boolean {
    return isRetryableManualFanoutPreparationError(error);
  }

  private buildManualFanoutActor(actor: {
    userId: string;
    username: string | null;
    displayName: string | null;
    chatId?: string | null;
    chatTitle?: string | null;
  }): AuthUser {
    return this.manualModerationRuntime.buildManualFanoutActor(actor);
  }

  private async deleteManualGroupCommandMessage(
    chatId: string,
    messageId: string,
    options: {
      botId?: string;
      originBotId?: string | null;
      actorUserId?: string | null;
    } = {},
  ): Promise<void> {
    await this.getManualMessageCleanupService().deleteGroupCommandMessage(
      chatId,
      messageId,
      options,
    );
  }

  private async deleteManualGroupCommandTargetMessage(
    job: {
      sourceChatId: string;
      commandBotId?: string | null;
      targetUserId: string;
      targetMessageId?: string | null;
    },
    options: { botId?: string } = {},
  ): Promise<void> {
    await this.getManualMessageCleanupService().deleteGroupCommandTargetMessage(job, options);
  }

  private resolveManualGroupCommandCleanupBotId(
    chatId: string,
    preferredBotId?: string | null,
  ): Promise<string | undefined> {
    return this.manualModerationRuntime.resolveManualGroupCommandCleanupBotId(
      chatId,
      preferredBotId,
    );
  }

  private resolveManualGroupCommandNoticeBotId(
    chatId: string,
    preferredBotId?: string | null,
  ): Promise<string | undefined> {
    return this.manualModerationRuntime.resolveManualGroupCommandNoticeBotId(
      chatId,
      preferredBotId,
    );
  }

  private sendManualGroupCommandNotice(
    params: Parameters<AdminManualModerationRuntime['sendManualGroupCommandNotice']>[0],
  ): Promise<void> {
    return this.manualModerationRuntime.sendManualGroupCommandNotice(params);
  }

  private extractManualGroupCommandErrorMessage(error: unknown): string {
    return this.manualModerationRuntime.extractManualGroupCommandErrorMessage(error);
  }

  private extractExpectedManualGroupCommandErrorMessage(error: unknown): string | null {
    return this.manualModerationRuntime.extractExpectedManualGroupCommandErrorMessage(error);
  }

  private resolveManualMuteCommandFollowUpSummaries(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    rootIntentKey?: string | null;
    botId?: string | null;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: ManualModerationFanoutSource;
    leaseGuard: ModerationSanctionStateLeaseGuard;
  }): Promise<{
    sourceMessageCleanup: ReturnType<AdminService['summarizeManualModerationCleanup']>;
    crossChatMuteFanout: ReturnType<AdminService['summarizeManualMuteFanout']>;
  }> {
    return this.manualModerationRuntime.resolveManualMuteCommandFollowUpSummaries(params);
  }

  private resolveManualBanFollowUpSummaries(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: ManualBanFollowUpSource;
    rootIntentKey?: string | null;
    leaseGuard: ModerationSanctionStateLeaseGuard;
  }): Promise<{
    sourceMessageCleanup: ReturnType<AdminService['summarizeManualModerationCleanup']>;
    crossChatFanout: ReturnType<AdminService['summarizeManualBanFanout']>;
  }> {
    return this.manualModerationRuntime.resolveManualBanFollowUpSummaries(params);
  }

  private resolveManualBanSourceCleanupSummary(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: ManualBanFollowUpSource;
    rootIntentKey?: string | null;
    botId?: string | null;
    leaseGuard: ModerationSanctionStateLeaseGuard;
  }) {
    return this.manualModerationRuntime.resolveManualBanSourceCleanupSummary(params);
  }

  private resolveManualBanFanoutSummary(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
    rootIntentKey?: string | null;
  }) {
    return this.manualModerationRuntime.resolveManualBanFanoutSummary(params);
  }

  private normalizeManualChatSilenceDurationHours(value: number | null | undefined): number {
    if (value === null || value === undefined) {
      return DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS;
    }

    const durationHours = Math.trunc(value);
    if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 14 * 24) {
      throw new BadRequestException('Для закрытия чата укажите срок от 1 до 336 ч.');
    }

    return durationHours;
  }

  private enqueueManualModerationFanout(job: AdminManualFanoutJob): Promise<boolean> {
    return this.manualModerationRuntime.enqueueManualModerationFanout(job);
  }
  private buildManualModerationFanoutOperationKey(params: {
    operation: ManualModerationFanoutLedgerOperation;
    sourceChatId: string;
    targetChatId: string;
    targetUserId: string;
    jobId?: string | null;
    rootIntentKey?: string | null;
    extra?: Array<string | number | boolean | null | undefined>;
  }): string {
    return buildManualModerationFanoutOperationKey(params);
  }

  private isTerminalManualModerationFanoutLedgerStatus(
    status: PrismaManualModerationFanoutLedgerStatus,
  ): boolean {
    return (
      status === PrismaManualModerationFanoutLedgerStatus.SUCCEEDED ||
      status === PrismaManualModerationFanoutLedgerStatus.SKIPPED ||
      status === PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS ||
      status === PrismaManualModerationFanoutLedgerStatus.FAILED_TERMINAL
    );
  }

  private isRetryableManualModerationFanoutLedgerStatus(
    status: PrismaManualModerationFanoutLedgerStatus,
  ): boolean {
    return status === PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE;
  }

  private isSucceededManualModerationFanoutLedgerClaim(
    claim: ManualModerationFanoutLedgerClaim,
  ): boolean {
    return (
      !claim.claimed && claim.row?.status === PrismaManualModerationFanoutLedgerStatus.SUCCEEDED
    );
  }

  private buildExistingManualModerationFanoutLedgerClaim(
    row: ManualModerationFanoutLedgerRow,
  ): ManualModerationFanoutLedgerClaim {
    return {
      claimed: false,
      operationKey: row.operationKey,
      row,
      reason:
        row.status === PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS
          ? 'fresh-lock'
          : row.status === PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS
            ? 'ambiguous'
            : 'terminal',
    };
  }

  private async readManualModerationFanoutIntentRow(params: {
    rootIntentKey: string;
    operation: Extract<
      ManualModerationFanoutLedgerOperation,
      'COMMAND_SOURCE_BAN' | 'COMMAND_SOURCE_MUTE'
    >;
    sourceChatId: string;
    targetChatId: string;
    targetUserId: string;
  }): Promise<ManualModerationFanoutLedgerRow | null> {
    const rows = (await this.prisma.manualModerationFanoutLedgerEntry.findMany({
      where: {
        rootIntentKey: params.rootIntentKey,
        operation: params.operation,
        sourceChatId: params.sourceChatId,
        targetChatId: params.targetChatId,
        targetUserId: params.targetUserId,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 16,
    })) as ManualModerationFanoutLedgerRow[];
    const statusPriority = [
      PrismaManualModerationFanoutLedgerStatus.SUCCEEDED,
      PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS,
      PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS,
      PrismaManualModerationFanoutLedgerStatus.FAILED_TERMINAL,
      PrismaManualModerationFanoutLedgerStatus.SKIPPED,
      PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
    ];
    for (const status of statusPriority) {
      const row = rows.find((candidate) => candidate.status === status);
      if (row) {
        return row;
      }
    }
    return rows[0] ?? null;
  }

  private resolveManualMuteResultFromLedger(
    row: ManualModerationFanoutLedgerRow,
    fallback: {
      userId: string;
      muteDurationHours: number | null;
      muteExpiresAt: Date | null;
      mutePermanent: boolean;
    },
  ): ManualModerationActionResult {
    return resolveManualMuteResultFromLedger(row, fallback);
  }

  private resolveManualBanExecutionModeFromLedger(
    row: ManualModerationFanoutLedgerRow,
    fallback: ManualBanExecutionMode = 'MAX_BLOCK',
  ): ManualBanExecutionMode {
    const metadata = this.readObjectPayloadOrNull(row.metadata);
    const value = row.executionMode ?? metadata?.executionMode;
    return value === 'MAX_REMOVE_ONLY' || value === 'MAX_BLOCK' ? value : fallback;
  }

  private resolveManualBanResultFromLedger(
    row: ManualModerationFanoutLedgerRow,
    targetUserId: string,
  ): ManualModerationActionResult {
    const executionMode = this.resolveManualBanExecutionModeFromLedger(row);
    return manualModerationActionResultSchema.parse({
      ok: true,
      action: 'BAN',
      userId: targetUserId,
      muteDurationHours: null,
      muteExpiresAt: null,
      message: executionMode === 'MAX_REMOVE_ONLY' ? 'Участник удалён из чата.' : 'Бан включён.',
    });
  }

  private throwManualModerationFanoutLedgerClaimBlocked(
    claim: ManualModerationFanoutLedgerClaim,
    actionLabel: string,
  ): never {
    if (claim.claimed) {
      throw new ServiceUnavailableException(
        'Операция модерации уже выполняется. Повторите попытку позже.',
      );
    }

    if (claim.reason === 'fresh-lock') {
      throw new ServiceUnavailableException(
        'Операция модерации уже выполняется. Повторите попытку позже.',
      );
    }

    if (claim.row?.status === PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS) {
      throw new ManualModerationOutcomeUncertainError(
        `MAX не подтвердил результат предыдущей попытки применить ${actionLabel}. Повтор не выполняется, чтобы не применить действие дважды.`,
      );
    }

    throw new BadRequestException(
      'Предыдущая попытка этой операции уже завершена. Проверьте статус участника перед повтором.',
    );
  }

  private async readManualModerationFanoutLedgerRow(
    operationKey: string,
  ): Promise<ManualModerationFanoutLedgerRow | null> {
    const rows = (await this.prisma.manualModerationFanoutLedgerEntry.findMany({
      where: { operationKey },
      take: 1,
    })) as ManualModerationFanoutLedgerRow[];
    return rows[0] ?? null;
  }

  private async claimManualModerationFanoutLedgerEntry(params: {
    operationKey: string;
    jobId?: string | null;
    rootIntentKey?: string | null;
    sourceKind: string;
    operation: ManualModerationFanoutLedgerOperation;
    sourceChatId: string;
    targetChatId: string;
    targetUserId: string;
    actorUserId: string;
    logicalAction: string;
    botId?: string | null;
    executionMode?: string | null;
    metadata?: Prisma.InputJsonValue | null;
  }): Promise<ManualModerationFanoutLedgerClaim> {
    const operationKey = params.operationKey.trim();
    const lockedAt = new Date();
    const lockToken = randomUUID();
    const rootIntentKey = this.readTrimmedString(params.rootIntentKey);
    const jobId = this.readTrimmedString(params.jobId);

    await this.prisma.manualModerationFanoutLedgerEntry.createMany({
      data: [
        {
          id: randomUUID(),
          operationKey,
          jobId: jobId ?? null,
          rootIntentKey: rootIntentKey ?? null,
          sourceKind: params.sourceKind,
          operation: params.operation,
          sourceChatId: params.sourceChatId,
          targetChatId: params.targetChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actorUserId,
          logicalAction: params.logicalAction,
          botId: params.botId ?? null,
          executionMode: params.executionMode ?? null,
          status: PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS,
          attemptCount: 1,
          lockedAt,
          lockToken,
          terminal: false,
          metadata: params.metadata ?? Prisma.JsonNull,
        },
      ],
      skipDuplicates: true,
    });

    let row = await this.readManualModerationFanoutLedgerRow(operationKey);
    if (!row) {
      return {
        claimed: false,
        operationKey,
        row: null,
        reason: 'fresh-lock',
      };
    }

    if (row.lockToken === lockToken) {
      return { claimed: true, operationKey, lockToken, row };
    }

    if (this.isTerminalManualModerationFanoutLedgerStatus(row.status)) {
      return {
        claimed: false,
        operationKey,
        row,
        reason:
          row.status === PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS
            ? 'ambiguous'
            : 'terminal',
      };
    }

    if (
      row.status === PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS &&
      row.lockedAt &&
      Date.now() - row.lockedAt.getTime() >= MANUAL_MODERATION_FANOUT_LEDGER_STALE_MS
    ) {
      const staleUpdated = await this.prisma.manualModerationFanoutLedgerEntry.updateMany({
        where: {
          operationKey,
          status: PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS,
          lockToken: row.lockToken,
        },
        data: {
          attemptCount: { increment: 1 },
          botId: params.botId ?? row.botId,
          executionMode: params.executionMode ?? row.executionMode,
          lockedAt,
          lockToken,
          terminal: false,
          lastError: null,
          lastStatusCode: null,
          lastErrorCode: null,
          metadata: params.metadata ?? row.metadata ?? Prisma.JsonNull,
        },
      });
      row = await this.readManualModerationFanoutLedgerRow(operationKey);
      if (staleUpdated.count === 1 && row) {
        return { claimed: true, operationKey, lockToken, row };
      }
      return {
        claimed: false,
        operationKey,
        row,
        reason: 'fresh-lock',
      };
    }

    if (!this.isRetryableManualModerationFanoutLedgerStatus(row.status)) {
      return {
        claimed: false,
        operationKey,
        row,
        reason: 'fresh-lock',
      };
    }

    const updated = await this.prisma.manualModerationFanoutLedgerEntry.updateMany({
      where: {
        operationKey,
        status: PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
      },
      data: {
        status: PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS,
        attemptCount: { increment: 1 },
        botId: params.botId ?? row.botId,
        executionMode: params.executionMode ?? row.executionMode,
        lockedAt,
        lockToken,
        terminal: false,
        lastError: null,
        lastStatusCode: null,
        lastErrorCode: null,
        metadata: params.metadata ?? row.metadata ?? Prisma.JsonNull,
      },
    });
    row = await this.readManualModerationFanoutLedgerRow(operationKey);
    if (updated.count === 1 && row) {
      return { claimed: true, operationKey, lockToken, row };
    }
    return {
      claimed: false,
      operationKey,
      row,
      reason: 'fresh-lock',
    };
  }

  private async completeManualModerationFanoutLedgerEntry(params: {
    operationKey: string;
    lockToken: string;
    status?: PrismaManualModerationFanoutLedgerStatus;
    botId?: string | null;
    executionMode?: string | null;
    moderationEventId?: string | null;
    auditLogId?: string | null;
    remoteMessageId?: string | null;
    metadata?: Prisma.InputJsonValue | null;
  }): Promise<void> {
    const updated = await this.prisma.manualModerationFanoutLedgerEntry.updateMany({
      where: {
        operationKey: params.operationKey,
        lockToken: params.lockToken,
        status: {
          in: [
            PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS,
            PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS,
          ],
        },
      },
      data: {
        status: params.status ?? PrismaManualModerationFanoutLedgerStatus.SUCCEEDED,
        botId: params.botId ?? undefined,
        executionMode: params.executionMode ?? undefined,
        moderationEventId: params.moderationEventId ?? undefined,
        auditLogId: params.auditLogId ?? undefined,
        remoteMessageId: params.remoteMessageId ?? undefined,
        lastError: null,
        lastStatusCode: null,
        lastErrorCode: null,
        terminal: true,
        lockedAt: null,
        lockToken: null,
        metadata: params.metadata ?? undefined,
      },
    });
    if (updated.count !== 1) {
      throw new ModerationSanctionStateChangedError();
    }
  }

  private async markManualModerationFanoutLedgerFailed(params: {
    operationKey: string;
    lockToken: string;
    status: PrismaManualModerationFanoutLedgerStatus;
    error: unknown;
    terminal?: boolean;
    retainClaim?: boolean;
    requireClaim?: boolean;
    botId?: string | null;
    executionMode?: string | null;
    metadata?: Prisma.InputJsonValue | null;
  }): Promise<boolean> {
    const updated = await this.prisma.manualModerationFanoutLedgerEntry.updateMany({
      where: {
        operationKey: params.operationKey,
        lockToken: params.lockToken,
        status: {
          in: [
            PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS,
            PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS,
          ],
        },
      },
      data: {
        status: params.status,
        botId: params.botId ?? undefined,
        executionMode: params.executionMode ?? undefined,
        lastError:
          extractMaxErrorMessage(params.error) ||
          this.extractHttpErrorMessage(params.error) ||
          (params.error instanceof Error ? params.error.message : String(params.error)),
        lastStatusCode: extractMaxErrorStatus(params.error),
        lastErrorCode: extractMaxErrorCode(params.error),
        terminal:
          params.terminal ??
          (params.status === PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS ||
            params.status === PrismaManualModerationFanoutLedgerStatus.FAILED_TERMINAL),
        lockedAt: params.retainClaim === true ? undefined : null,
        lockToken: params.retainClaim === true ? undefined : null,
        metadata: params.metadata ?? undefined,
      },
    });
    if (params.requireClaim === true && updated.count !== 1) {
      throw new ModerationSanctionStateChangedError();
    }
    return updated.count === 1;
  }

  private async runManualBanSourceCleanup(
    chatId: string,
    targetUserId: string,
    actorUserId: string,
    options: {
      logMessage?: string;
      botId?: string;
      leaseGuard?: ModerationSanctionStateLeaseGuard;
    } = {},
  ): Promise<{
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    pendingMessageIds: string[];
    failedMessageIds: string[];
  }> {
    return this.runDeferredManualModerationSourceCleanup(
      chatId,
      targetUserId,
      actorUserId,
      options.logMessage ?? 'Failed to run recent message cleanup after manual system ban',
      options.botId,
      options.leaseGuard,
    );
  }

  private async runManualSourceCleanupWithLedger(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    sourceKind: string;
    sourceChatId: string;
    targetUserId: string;
    actorUserId: string;
    botId?: string | null;
    logMessage: string;
  }): Promise<{
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    pendingMessageIds: string[];
    failedMessageIds: string[];
  }> {
    const operationKey = this.buildManualModerationFanoutOperationKey({
      operation: 'SOURCE_CLEANUP',
      sourceChatId: params.sourceChatId,
      targetChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      jobId: params.jobId,
      rootIntentKey: params.rootIntentKey,
      extra: ['recent_messages'],
    });
    const claim = await this.claimManualModerationFanoutLedgerEntry({
      operationKey,
      jobId: params.jobId,
      rootIntentKey: params.rootIntentKey,
      sourceKind: params.sourceKind,
      operation: 'SOURCE_CLEANUP',
      sourceChatId: params.sourceChatId,
      targetChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      actorUserId: params.actorUserId,
      logicalAction: 'DELETE_MESSAGES',
      botId: params.botId ?? null,
    });
    if (!claim.claimed) {
      return {
        candidateMessageIds: [],
        deletedMessageIds: [],
        pendingMessageIds: [],
        failedMessageIds: [],
      };
    }

    const cleanup = await this.runDeferredManualModerationSourceCleanup(
      params.sourceChatId,
      params.targetUserId,
      params.actorUserId,
      params.logMessage,
      params.botId ?? undefined,
    );
    await this.completeManualModerationFanoutLedgerEntry({
      operationKey,
      lockToken: claim.lockToken,
      botId: params.botId ?? null,
      metadata: cleanup as Prisma.InputJsonValue,
    });
    return cleanup;
  }

  private async runDeferredManualModerationSourceCleanup(
    chatId: string,
    targetUserId: string,
    actorUserId: string,
    logMessage: string,
    botId?: string,
    leaseGuard?: ModerationSanctionStateLeaseGuard,
  ): Promise<{
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    pendingMessageIds: string[];
    failedMessageIds: string[];
  }> {
    try {
      const canResolveDeleteBot =
        typeof (this.maxClient as Partial<MaxClientService>).getCurrentChatMemberAccess ===
        'function';
      return await this.deleteRecentTrackedMessagesForManualAction(chatId, targetUserId, {
        botId:
          botId ??
          (canResolveDeleteBot
            ? await this.resolveManualModerationActionBotAssignment(chatId, 'delete_message')
            : undefined),
        leaseGuard,
      });
    } catch (error: unknown) {
      if (this.isManualModerationOrderingFailure(error)) {
        throw error;
      }
      this.logger.warn(
        {
          chatId,
          targetUserId,
          actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        logMessage,
      );
      return {
        candidateMessageIds: [],
        deletedMessageIds: [],
        pendingMessageIds: [],
        failedMessageIds: [],
      };
    }
  }

  private async runManualBanFanoutInlineSummary(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: ManualBanFollowUpSource;
  }) {
    try {
      const fanout = await this.applyManualSystemBanFanout(params);
      return this.summarizeManualBanFanout(fanout);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.sourceChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run manual system ban fanout after source chat ban',
      );
      return this.summarizeManualBanFanout({
        removedChatIds: [],
        skippedChatIds: [],
        failedChatIds: [],
        deletedMessageCount: 0,
        failedMessageDeleteCount: 0,
      });
    }
  }

  private async applyManualMuteFanout(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: ManualModerationFanoutSource;
    targetChats?: ChatSummary[];
  }): Promise<{
    mutedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
    retryableFailedChatIds?: string[];
  }> {
    const {
      sourceChatId,
      targetUserId,
      actor,
      muteDurationHours,
      muteExpiresAt,
      mutePermanent,
      source,
    } = params;
    if (this.isKnownRuntimeBotUserId(targetUserId)) {
      this.logger.warn(
        {
          sourceChatId,
          targetUserId,
          actorUserId: actor.userId,
        },
        'Skipped manual mute fanout for configured MAX bot user',
      );
      return {
        mutedChatIds: [],
        skippedChatIds: [],
        failedChatIds: [],
        retryableFailedChatIds: [],
      };
    }

    const targetDisplayName = await this.resolveManualModerationTargetDisplayName(
      sourceChatId,
      targetUserId,
      {
        allowRemoteLookup: false,
      },
    );
    const result = {
      mutedChatIds: [] as string[],
      skippedChatIds: [] as string[],
      failedChatIds: [] as string[],
      retryableFailedChatIds: [] as string[],
    };
    const chats =
      params.targetChats ?? (await this.resolveManualCommandFanoutChats(actor, sourceChatId));

    for (const [index, chat] of chats.entries()) {
      if (index > 0) {
        await sleepIfNeeded(this.manualFanoutLookupSpacingMs);
      }

      const preparedTarget = await this.manualModerationRuntime.prepareManualMuteFanoutTarget({
        jobId: params.jobId,
        rootIntentKey: params.rootIntentKey,
        sourceChatId,
        targetChatId: chat.id,
        targetUserId,
        actorUserId: actor.userId,
        muteDurationHours,
        muteExpiresAt,
        mutePermanent,
        source,
      });
      if (preparedTarget.kind === 'settled') {
        if (preparedTarget.outcome === 'muted') {
          result.mutedChatIds.push(chat.id);
        } else if (preparedTarget.outcome === 'skipped') {
          result.skippedChatIds.push(chat.id);
        } else {
          result.failedChatIds.push(chat.id);
          if (preparedTarget.retryable) {
            result.retryableFailedChatIds.push(chat.id);
          }
        }
        continue;
      }
      const { botId: resolvedBotId, operationKey, metadata: muteMetadata } = preparedTarget;
      const claim = preparedTarget;

      try {
        const transition = await this.moderationSanctionStateLock.runExclusive(
          { chatId: chat.id, userId: targetUserId },
          async (leaseGuard) => {
            const targetState = await this.resolveManualFanoutTargetState(chat.id, targetUserId, {
              trafficClass: 'background',
              ...(resolvedBotId ? { botId: resolvedBotId } : {}),
            });
            if (targetState !== 'present') {
              await leaseGuard.assertOwned();
              await this.completeManualModerationFanoutLedgerEntry({
                operationKey,
                lockToken: claim.lockToken,
                status: PrismaManualModerationFanoutLedgerStatus.SKIPPED,
                botId: resolvedBotId ?? null,
                metadata: {
                  ...muteMetadata,
                  targetState,
                },
              });
              return 'skipped' as const;
            }

            const sanctionFence = await this.prepareManualSanctionStateFence({
              chatId: chat.id,
              targetUserId,
              intendedAction: 'MUTE',
              source,
              leaseGuard,
            });
            let moderationEventId: string;
            try {
              await leaseGuard.assertOwned();
              moderationEventId = await this.recordManualModerationAction({
                chatId: chat.id,
                targetUserId,
                targetDisplayName,
                actorUserId: actor.userId,
                ruleCode: 'MANUAL_MUTE',
                sanctionAction: SanctionAction.MUTE,
                auditAction: 'MANUAL_MUTE_MEMBER',
                metadata: {
                  source,
                  initiatedByUserId: actor.userId,
                  reason: `Ручной мут участника ${this.describeManualModerationActionSource(source)}`,
                  ...this.buildManualMuteMetadataFields({
                    muteDurationHours,
                    muteExpiresAt,
                    mutePermanent,
                  }),
                  sourceChatId,
                  fanout: true,
                },
                auditPayload: {
                  userId: targetUserId,
                  source,
                  ...this.buildManualMuteMetadataFields({
                    muteDurationHours,
                    muteExpiresAt,
                    mutePermanent,
                  }),
                  sourceChatId,
                  fanout: true,
                },
                fanoutLedger: {
                  operationKey,
                  lockToken: claim.lockToken,
                  botId: resolvedBotId ?? null,
                  metadata: muteMetadata,
                },
              });
            } catch (error: unknown) {
              await this.abortManualSanctionStateFence(sanctionFence);
              throw error;
            }
            await this.commitManualSanctionStateFence(sanctionFence, moderationEventId);
            return 'muted' as const;
          },
        );
        if (transition === 'skipped') {
          result.skippedChatIds.push(chat.id);
        } else {
          result.mutedChatIds.push(chat.id);
        }
      } catch (error: unknown) {
        const orderingFailure = this.isManualModerationOrderingFailure(error);
        const retryableOrderingFailure = this.isRetryableManualModerationOrderingFailure(error);
        await this.markManualModerationFanoutLedgerFailed({
          operationKey,
          lockToken: claim.lockToken,
          status:
            orderingFailure && !retryableOrderingFailure
              ? PrismaManualModerationFanoutLedgerStatus.FAILED_TERMINAL
              : PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
          error,
          botId: resolvedBotId ?? null,
          metadata: muteMetadata,
        });
        this.logger.warn(
          {
            chatId: chat.id,
            targetUserId,
            actorUserId: actor.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to apply manual mute fanout in managed chat',
        );
        result.failedChatIds.push(chat.id);
        if (!orderingFailure || retryableOrderingFailure) {
          result.retryableFailedChatIds.push(chat.id);
        }
      }
    }

    return result;
  }

  private async applyManualSystemBanFanout(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    source?: ManualBanFollowUpSource;
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    targetChats?: ChatSummary[];
  }): Promise<{
    removedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
    retryableFailedChatIds?: string[];
    deletedMessageCount: number;
    failedMessageDeleteCount: number;
  }> {
    const { sourceChatId, targetUserId, actor } = params;
    if (this.isKnownRuntimeBotUserId(targetUserId)) {
      this.logger.warn(
        {
          sourceChatId,
          targetUserId,
          actorUserId: actor.userId,
        },
        'Skipped manual ban fanout for configured MAX bot user',
      );
      return {
        removedChatIds: [],
        skippedChatIds: [],
        failedChatIds: [],
        retryableFailedChatIds: [],
        deletedMessageCount: 0,
        failedMessageDeleteCount: 0,
      };
    }

    const result = {
      removedChatIds: [] as string[],
      skippedChatIds: [] as string[],
      failedChatIds: [] as string[],
      retryableFailedChatIds: [] as string[],
      deletedMessageCount: 0,
      failedMessageDeleteCount: 0,
    };
    const chats =
      params.targetChats ?? (await this.resolveManualCommandFanoutChats(actor, sourceChatId));

    for (const [index, chat] of chats.entries()) {
      if (index > 0) {
        await sleepIfNeeded(this.manualFanoutLookupSpacingMs);
      }

      let resolvedBotId: string | undefined;
      try {
        resolvedBotId = await this.resolveManualModerationActionBotAssignment(
          chat.id,
          'moderate_member',
        );
      } catch (error: unknown) {
        const retryable = this.isRetryableManualFanoutPreparationError(error);
        this.logger.warn(
          { chatId: chat.id, targetUserId, err: String(error) },
          'Manual ban fanout has no eligible bot route',
        );
        result.failedChatIds.push(chat.id);
        if (retryable) {
          result.retryableFailedChatIds.push(chat.id);
        }
        continue;
      }

      const operationKey = this.buildManualModerationFanoutOperationKey({
        operation: 'FANOUT_BAN_MEMBER',
        sourceChatId,
        targetChatId: chat.id,
        targetUserId,
        jobId: params.jobId,
        rootIntentKey: params.rootIntentKey,
      });
      const banMetadataBase = {
        source: params.source ?? 'group_command',
        sourceChatId,
      } satisfies Prisma.InputJsonObject;
      const claim = await this.claimManualModerationFanoutLedgerEntry({
        operationKey,
        jobId: params.jobId,
        rootIntentKey: params.rootIntentKey,
        sourceKind: 'manual_ban_fanout',
        operation: 'FANOUT_BAN_MEMBER',
        sourceChatId,
        targetChatId: chat.id,
        targetUserId,
        actorUserId: actor.userId,
        logicalAction: 'BAN',
        botId: resolvedBotId ?? null,
        metadata: banMetadataBase,
      });
      if (!claim.claimed) {
        if (claim.row?.status === PrismaManualModerationFanoutLedgerStatus.SUCCEEDED) {
          result.removedChatIds.push(chat.id);
        } else if (claim.row?.status === PrismaManualModerationFanoutLedgerStatus.SKIPPED) {
          result.skippedChatIds.push(chat.id);
        } else {
          result.failedChatIds.push(chat.id);
        }
        continue;
      }

      try {
        await this.assertBotCanManageMembers(chat.id, 'BAN', resolvedBotId);
      } catch (error: unknown) {
        const retryable = this.isRetryableManualFanoutPreparationError(error);
        await this.markManualModerationFanoutLedgerFailed({
          operationKey,
          lockToken: claim.lockToken,
          status: retryable
            ? PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE
            : PrismaManualModerationFanoutLedgerStatus.FAILED_TERMINAL,
          error,
          botId: resolvedBotId ?? null,
          metadata: banMetadataBase,
        });
        this.logger.warn(
          {
            chatId: chat.id,
            targetUserId,
            actorUserId: actor.userId,
            err: this.extractHttpErrorMessage(error) || String(error),
          },
          'Skipped manual ban fanout because the bot cannot manage members in chat',
        );
        result.failedChatIds.push(chat.id);
        if (retryable) {
          result.retryableFailedChatIds.push(chat.id);
        }
        continue;
      }

      let executionMode: ManualBanExecutionMode = 'MAX_BLOCK';
      let remoteActionConfirmed = false;
      let sanctionFence: ModerationSanctionStateFence | null = null;
      try {
        await sleepIfNeeded(this.manualFanoutActionSpacingMs);
        executionMode = await this.resolveManualBanExecutionMode(chat.id, resolvedBotId);
        const transition = await this.moderationSanctionStateLock.runExclusive(
          { chatId: chat.id, userId: targetUserId },
          async (leaseGuard) => {
            const targetState = await prepareManualBanFanoutTarget({
              chatId: chat.id,
              targetUserId,
              executionMode,
              leaseGuard,
              resolveTargetState: () =>
                this.resolveConfirmedManualFanoutTargetState(chat.id, targetUserId, {
                  trafficClass: 'background',
                  bypassCache: true,
                  ...(resolvedBotId ? { botId: resolvedBotId } : {}),
                }),
              clearTerminalBanState: (completedBefore) =>
                this.clearTerminalBanStateAfterConfirmedUnban(
                  chat.id,
                  targetUserId,
                  completedBefore,
                ),
            });
            if (targetState !== 'present') {
              await leaseGuard.assertOwned();
              await this.completeManualModerationFanoutLedgerEntry({
                operationKey,
                lockToken: claim.lockToken,
                status: PrismaManualModerationFanoutLedgerStatus.SKIPPED,
                botId: resolvedBotId ?? null,
                metadata: {
                  ...banMetadataBase,
                  targetState,
                },
              });
              return { kind: 'skipped' } as const;
            }

            sanctionFence = await this.prepareManualSanctionStateFence({
              chatId: chat.id,
              targetUserId,
              intendedAction: 'BAN',
              source: params.source ?? 'group_command',
              leaseGuard,
            });
            await leaseGuard.assertOwned();
            try {
              if (resolvedBotId) {
                await this.maxClient.cancelScheduledUnban(chat.id, targetUserId, {
                  botId: resolvedBotId,
                });
              } else {
                await this.maxClient.cancelScheduledUnban(chat.id, targetUserId);
              }
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId: chat.id,
                  targetUserId,
                  err: error instanceof Error ? error.message : String(error),
                },
                'Failed to cancel scheduled auto-unban before manual ban fanout',
              );
            }

            const actionStartedMetadata = {
              ...banMetadataBase,
              executionMode,
              actionStartedAt: new Date().toISOString(),
            } satisfies Prisma.InputJsonObject;
            await leaseGuard.assertOwned();
            await this.markManualModerationFanoutLedgerFailed({
              operationKey,
              lockToken: claim.lockToken,
              status: PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS,
              error: new Error(
                'manual ban fanout member action started; outcome unknown until confirmed',
              ),
              botId: resolvedBotId ?? null,
              executionMode,
              metadata: actionStartedMetadata,
              retainClaim: true,
              requireClaim: true,
            });
            await leaseGuard.assertOwned();
            if (executionMode === 'MAX_REMOVE_ONLY') {
              await this.maxClient.kickMember(chat.id, targetUserId, {
                immediate: true,
                beforeImmediateMemberMutation: () => leaseGuard.assertOwned(),
                ...(resolvedBotId ? { botId: resolvedBotId } : {}),
              });
            } else {
              await this.maxClient.banMember(chat.id, targetUserId, {
                immediate: true,
                beforeImmediateMemberMutation: () => leaseGuard.assertOwned(),
                ...(resolvedBotId ? { botId: resolvedBotId } : {}),
              });
            }
            remoteActionConfirmed = true;

            await leaseGuard.assertOwned();
            const cleanup = await this.deleteRecentTrackedMessagesForManualAction(
              chat.id,
              targetUserId,
              {
                spacingMs: this.manualFanoutActionSpacingMs,
                botId: resolvedBotId,
                leaseGuard,
              },
            );
            await leaseGuard.assertOwned();
            const moderationEventId = await this.recordManualModerationAction({
              chatId: chat.id,
              targetUserId,
              actorUserId: actor.userId,
              ruleCode: 'MANUAL_BAN',
              sanctionAction: SanctionAction.BAN,
              auditAction: 'MANUAL_BAN_MEMBER',
              metadata: {
                source: params.source ?? 'group_command',
                initiatedByUserId: actor.userId,
                reason: `Ручной бан участника ${this.describeManualModerationActionSource(
                  params.source ?? 'group_command',
                )}`,
                mode: executionMode,
                permanent: true,
                sourceChatId,
                fanout: true,
                cleanup,
              },
              auditPayload: {
                userId: targetUserId,
                source: params.source ?? 'group_command',
                mode: executionMode,
                permanent: true,
                sourceChatId,
                fanout: true,
                cleanup,
              },
              fanoutLedger: {
                operationKey,
                lockToken: claim.lockToken,
                botId: resolvedBotId ?? null,
                executionMode,
                metadata: {
                  ...banMetadataBase,
                  executionMode,
                  cleanup,
                },
              },
            });
            await this.commitManualSanctionStateFence(sanctionFence, moderationEventId);
            return { kind: 'removed', cleanup } as const;
          },
        );
        if (transition.kind === 'skipped') {
          result.skippedChatIds.push(chat.id);
        } else {
          result.removedChatIds.push(chat.id);
          result.deletedMessageCount += transition.cleanup.deletedMessageIds.length;
          result.failedMessageDeleteCount += transition.cleanup.failedMessageIds.length;
        }
      } catch (error: unknown) {
        const orderingFailure = this.isManualModerationOrderingFailure(error);
        const retryableOrderingFailure = this.isRetryableManualModerationOrderingFailure(error);
        const ambiguousAttemptedMutation = this.isAmbiguousAttemptedMaxMemberMutation(error);
        this.logger.warn(
          {
            chatId: chat.id,
            targetUserId,
            actorUserId: actor.userId,
            err:
              this.extractMaxApiErrorMessage(error) ||
              this.extractHttpErrorMessage(error) ||
              String(error),
          },
          'Failed to apply manual ban fanout in managed chat',
        );
        if (sanctionFence) {
          if (remoteActionConfirmed) {
            await this.markManualSanctionStateFenceRemoteConfirmedEventMissing(sanctionFence);
          } else if (!ambiguousAttemptedMutation) {
            await this.abortManualSanctionStateFence(sanctionFence);
          }
        }
        await this.markManualModerationFanoutLedgerFailed({
          operationKey,
          lockToken: claim.lockToken,
          status:
            remoteActionConfirmed || ambiguousAttemptedMutation
              ? PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS
              : orderingFailure && !retryableOrderingFailure
                ? PrismaManualModerationFanoutLedgerStatus.FAILED_TERMINAL
                : PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
          error,
          botId: resolvedBotId ?? null,
          executionMode,
          metadata: {
            ...banMetadataBase,
            executionMode,
          },
        });
        result.failedChatIds.push(chat.id);
        if (
          !remoteActionConfirmed &&
          !ambiguousAttemptedMutation &&
          (!orderingFailure || retryableOrderingFailure)
        ) {
          result.retryableFailedChatIds.push(chat.id);
        }
        continue;
      }
    }

    return result;
  }

  private async resolveManualCommandFanoutChats(
    actor: AuthUser,
    sourceChatId: string,
  ): Promise<ChatSummary[]> {
    await this.assertManagedEntityAdminAccess(sourceChatId, actor.userId, 'chat');
    const maxClientWithChatListing = this.maxClient as MaxClientService & {
      listBotChats?: MaxClientService['listBotChats'];
    };

    let chats: ChatSummary[];
    try {
      chats =
        typeof maxClientWithChatListing.listBotChats === 'function'
          ? await this.listChatsForMassBroadcast(actor, { discoveryMode: 'cached-first' })
          : await this.listChatsFromAllowlist(actor.userId, 'chat');
    } catch (error: unknown) {
      this.logger.warn(
        {
          actorUserId: actor.userId,
          sourceChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve manual command fanout chats; falling back to allowlist cache',
      );
      chats = await this.listChatsFromAllowlist(actor.userId, 'chat');
    }

    const targetChats = chats.filter(
      (chat) =>
        chat.entityType === 'chat' &&
        chat.id !== sourceChatId &&
        !isUnsupportedManagedChat(chat.id, chat.entityType),
    );
    const checkedChatIds = new Set<string>();
    for (const chat of targetChats) {
      if (checkedChatIds.has(chat.id)) {
        continue;
      }
      await this.assertManagedEntityAdminAccess(chat.id, actor.userId, 'chat');
      checkedChatIds.add(chat.id);
    }
    return targetChats;
  }

  private async resolveManualFanoutTargetState(
    chatId: string,
    targetUserId: string,
    requestOptions: {
      trafficClass?: 'critical' | 'interactive' | 'background';
      botId?: string;
    } = {},
  ): Promise<'present' | 'absent' | 'protected'> {
    return (
      (await this.resolveConfirmedManualFanoutTargetState(chatId, targetUserId, requestOptions)) ??
      'present'
    );
  }

  private async resolveConfirmedManualFanoutTargetState(
    chatId: string,
    targetUserId: string,
    requestOptions: {
      trafficClass?: 'critical' | 'interactive' | 'background';
      botId?: string;
      bypassCache?: boolean;
    } = {},
  ): Promise<'present' | 'absent' | 'protected' | null> {
    const maxClientWithMemberAccess = this.maxClient as MaxClientService & {
      getChatMemberAccess?: (
        chatId: string,
        userId: string,
        options?: {
          trafficClass?: 'critical' | 'interactive' | 'background';
          botId?: string;
          bypassCache?: boolean;
        },
      ) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return null;
    }

    try {
      const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(
        chatId,
        targetUserId,
        requestOptions,
      );
      if (!targetAccess) {
        return 'absent';
      }
      if (targetAccess.isOwner || targetAccess.isAdmin) {
        return 'protected';
      }
      return 'present';
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to confirm target state for manual command fanout',
      );
      return null;
    }
  }

  private async deleteRecentTrackedMessagesForManualAction(
    chatId: string,
    targetUserId: string,
    options: {
      spacingMs?: number;
      botId?: string;
      leaseGuard?: ModerationSanctionStateLeaseGuard;
    } = {},
  ): Promise<{
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    pendingMessageIds: string[];
    failedMessageIds: string[];
  }> {
    return this.getManualMessageCleanupService().deleteRecentTrackedMessages(
      chatId,
      targetUserId,
      options,
    );
  }

  private getManualMessageCleanupService(): AdminManualMessageCleanupService {
    return (
      this.manualMessageCleanupService ??
      new AdminManualMessageCleanupService(
        this.prisma,
        this.maxClient,
        this.moderationDeleteIntentService,
      )
    );
  }

  private summarizeManualModerationCleanup(result: {
    candidateMessageIds: string[];
    deletedMessageIds: string[];
    pendingMessageIds: string[];
    failedMessageIds: string[];
  }) {
    return summarizeManualModerationCleanup(result);
  }

  private summarizeManualBanFanout(result: {
    removedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
    deletedMessageCount: number;
    failedMessageDeleteCount: number;
  }) {
    return summarizeManualBanFanout(result);
  }

  private summarizeManualMuteFanout(result: {
    mutedChatIds: string[];
    skippedChatIds: string[];
    failedChatIds: string[];
  }) {
    return summarizeManualMuteFanout(result);
  }

  private async prepareManualModerationTarget(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    options: { skipActorAdminCheck?: boolean } = {},
  ): Promise<string> {
    if (options.skipActorAdminCheck !== true) {
      await this.assertChatAdmin(chatId, user.userId, null, {
        trafficClass: 'critical',
      });
    }
    const targetUserId = targetUserIdRaw.trim();
    if (!targetUserId) {
      throw new BadRequestException('User ID is required');
    }
    if (targetUserId === user.userId) {
      throw new BadRequestException('Нельзя применять это действие к своему аккаунту.');
    }

    return targetUserId;
  }

  private async assertManualMemberModerationPreconditions(
    chatId: string,
    targetUserId: string,
    action: ManualMemberModerationAction,
    botId?: string,
    allowFormerParticipant = false,
  ): Promise<'present' | 'former'> {
    if (action === 'BAN') {
      await this.assertBotCanManageMembers(chatId, action, botId);
    } else {
      await this.assertBotCanDeleteMessages(chatId, botId);
    }
    return this.assertTargetUserCanBeModerated(
      chatId,
      targetUserId,
      action,
      botId,
      allowFormerParticipant,
    );
  }

  private async assertBotCanManageMembers(
    chatId: string,
    action: ManualMemberManageMembersAction,
    botId?: string,
  ): Promise<void> {
    const maxClientWithAccess = this.maxClient as MaxClientService & {
      getCurrentChatMemberAccess?: (chatId: string) => Promise<MaxChatMemberAccess>;
    };
    if (typeof maxClientWithAccess.getCurrentChatMemberAccess !== 'function') {
      return;
    }

    let botAccess: MaxChatMemberAccess;
    try {
      botAccess = await maxClientWithAccess.getCurrentChatMemberAccess(chatId, {
        trafficClass: 'critical',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(botId ? { botId } : {}),
      } as never);
    } catch (error: unknown) {
      if (isBotAdminLookupDeniedError(error)) {
        throw new ForbiddenException(
          'Действие недоступно: бот больше не состоит в этом чате MAX или утратил права администратора.',
        );
      }
      throw error;
    }

    if (botAccess.isOwner) {
      return;
    }

    if (!botAccess.isAdmin) {
      throw new ForbiddenException(
        action === 'BAN'
          ? 'Для бана боту нужны права администратора этого чата MAX.'
          : action === 'UNBAN'
            ? 'Чтобы снять блокировку и вернуть участника, боту нужны права администратора этого чата MAX.'
            : 'Для модерации участников боту нужны права администратора этого чата MAX.',
      );
    }

    if (
      botAccess.permissions.length > 0 &&
      !botAccess.permissions.some((permission) => this.isAddRemoveMembersPermission(permission))
    ) {
      throw new ForbiddenException(
        action === 'BAN'
          ? 'В правах бота нет управления участниками (add_remove_members), поэтому бан недоступен.'
          : action === 'UNBAN'
            ? 'В правах бота нет управления участниками (add_remove_members), поэтому снять блокировку нельзя.'
            : 'В правах бота нет управления участниками (add_remove_members), поэтому действие недоступно.',
      );
    }
  }

  private async assertBotCanDeleteMessages(
    chatId: string,
    botId?: string,
    entityType: ChatEntityType = ChatEntityType.CHAT,
  ): Promise<void> {
    const maxClientWithAccess = this.maxClient as MaxClientService & {
      getCurrentChatMemberAccess?: MaxClientService['getCurrentChatMemberAccess'];
    };
    if (typeof maxClientWithAccess.getCurrentChatMemberAccess !== 'function') {
      throw new ServiceUnavailableException(
        'Не удалось подтвердить право бота MAX удалять сообщения. Повторите попытку позже.',
      );
    }

    let botAccess: MaxChatMemberAccess;
    try {
      botAccess = await maxClientWithAccess.getCurrentChatMemberAccess(chatId, {
        trafficClass: 'critical',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(botId ? { botId } : {}),
      });
    } catch (error: unknown) {
      if (isBotAdminLookupDeniedError(error)) {
        throw new ForbiddenException(
          'Действие недоступно: бот больше не состоит в этом чате MAX или утратил права администратора.',
        );
      }
      throw error;
    }

    if (
      !hasConfirmedDeleteMessageAccess(
        {
          checkedAt: null,
          isAdmin: botAccess.isAdmin,
          isOwner: botAccess.isOwner,
          permissions: botAccess.permissions,
        },
        entityType,
      )
    ) {
      throw new ForbiddenException(
        entityType === ChatEntityType.CHANNEL
          ? 'Для удаления сообщений канала боту нужны read_all_messages и право delete.'
          : 'Для удаления сообщений чата боту нужны read_all_messages и право write.',
      );
    }
  }

  private async assertTargetUserCanBeModerated(
    chatId: string,
    targetUserId: string,
    action: ManualMemberModerationAction,
    botId?: string,
    allowFormerParticipant = false,
  ): Promise<'present' | 'former'> {
    if (this.isKnownRuntimeBotUserId(targetUserId)) {
      throw new BadRequestException(
        'Действие отклонено: настроенные боты MAX защищены от модерации.',
      );
    }

    const maxClientWithMemberAccess = this.maxClient as MaxClientService & {
      getChatMemberAccess?: (chatId: string, userId: string) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return 'present';
    }

    const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(chatId, targetUserId, {
      trafficClass: 'critical',
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      ...(allowFormerParticipant ? { bypassCache: true } : {}),
      ...(botId ? { botId } : {}),
    } as never);
    if (!targetAccess) {
      if (
        allowFormerParticipant &&
        (await this.prisma.chat.findUnique({ where: { id: chatId }, select: { entityType: true } }))
          ?.entityType === ChatEntityType.CHAT &&
        (await hasFormerParticipantHistory(this.prisma, chatId, targetUserId))
      ) {
        return 'former';
      }
      throw new BadRequestException('Участник уже вышел из чата или был удалён.');
    }

    if (targetAccess.isOwner || targetAccess.isAdmin) {
      throw new BadRequestException(
        action === 'BAN'
          ? 'Бан нельзя применить к владельцу или администратору чата.'
          : 'Мут нельзя применить к владельцу или администратору чата.',
      );
    }
    return 'present';
  }

  private isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      return false;
    }

    const maxBotRegistry = this.maxBotRegistry as
      | (MaxBotRegistryService & {
          isKnownBotUserId?: (value: string | null | undefined) => boolean;
        })
      | undefined;
    if (maxBotRegistry?.isKnownBotUserId?.(userId)) {
      return true;
    }

    if (this.maxBotLinkService?.isKnownBotUserId?.(userId)) {
      return true;
    }

    const normalized = userId.trim();
    return normalized === this.ownBotUserId || normalized === this.explicitBotContactId;
  }

  private async resolveManualBanExecutionMode(
    chatId: string,
    botId?: string,
  ): Promise<ManualBanExecutionMode> {
    return resolveManualMemberBanMode(this.maxClient, this.logger, chatId, botId);
  }

  private async resolveManualUnbanExecutionMode(
    chatId: string,
    targetUserId: string,
    botId?: string,
  ): Promise<ManualUnbanExecutionMode> {
    const maxClientWithMemberAccess = this.maxClient as MaxClientService & {
      getChatMemberAccess?: (chatId: string, userId: string) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return 'MAX_UNBLOCK';
    }

    try {
      const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(
        chatId,
        targetUserId,
        {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          ...(botId ? { botId } : {}),
        } as never,
      );
      return targetAccess ? 'ALREADY_PRESENT' : 'MAX_UNBLOCK';
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId: targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve target member state before manual unban',
      );
      return 'MAX_UNBLOCK';
    }
  }

  private async clearTerminalBanStateAfterConfirmedUnban(
    chatId: string,
    targetUserId: string,
    completedBefore?: Date,
  ): Promise<void> {
    const clearTerminalBanState = (this.maxClient as Partial<MaxClientService>)
      .clearTerminalBanStateAfterConfirmedUnban;
    if (typeof clearTerminalBanState === 'function') {
      if (completedBefore) {
        await clearTerminalBanState.call(this.maxClient, chatId, targetUserId, completedBefore);
      } else {
        await clearTerminalBanState.call(this.maxClient, chatId, targetUserId);
      }
    }
  }

  private isAlreadyPresentMemberAddError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
      (normalized.includes('already') &&
        (normalized.includes('member') || normalized.includes('participant'))) ||
      normalized.includes('уже состоит')
    );
  }

  private async resolveManualMemberModerationErrorMessage(
    chatId: string,
    targetUserId: string,
    action: ManualMemberModerationAction,
    error: unknown,
    botId?: string,
  ): Promise<string> {
    const maxApiMessage = this.extractMaxApiErrorMessage(error);
    if (!this.isAmbiguousMaxMemberModerationError(maxApiMessage)) {
      return action === 'BAN'
        ? 'MAX отклонил бан. Проверьте тип чата, статус участника и права бота.'
        : 'MAX отклонил мут. Проверьте статус участника и права бота.';
    }

    try {
      await this.assertBotCanManageMembers(chatId, action, botId);
    } catch (diagnosticError: unknown) {
      return (
        this.extractExpectedManualGroupCommandErrorMessage(diagnosticError) ||
        (action === 'BAN'
          ? 'MAX отклонил бан. Проверьте тип чата, статус участника и права бота.'
          : 'MAX отклонил мут. Проверьте статус участника и права бота.')
      );
    }

    try {
      await this.assertTargetUserCanBeModerated(chatId, targetUserId, action, botId);
    } catch (diagnosticError: unknown) {
      return (
        this.extractExpectedManualGroupCommandErrorMessage(diagnosticError) ||
        (action === 'BAN'
          ? 'MAX отклонил бан. Проверьте тип чата, статус участника и права бота.'
          : 'MAX отклонил мут. Проверьте статус участника и права бота.')
      );
    }

    return action === 'BAN'
      ? 'MAX отклонил бан. Проверьте тип чата, статус участника и права бота.'
      : 'MAX отклонил мут. Проверьте статус участника и права бота.';
  }

  private async resolveManualMemberUnbanErrorMessage(
    chatId: string,
    targetUserId: string,
    error: unknown,
    botId?: string,
  ): Promise<string> {
    const maxApiMessage = this.extractMaxApiErrorMessage(error);
    if (maxApiMessage && !this.isAmbiguousMaxMemberModerationError(maxApiMessage)) {
      return 'Участника не удалось вернуть в чат: MAX отклонил действие. Проверьте тип чата, статус участника и права бота.';
    }

    try {
      await this.assertBotCanManageMembers(chatId, 'UNBAN', botId);
    } catch (diagnosticError: unknown) {
      return (
        this.extractExpectedManualGroupCommandErrorMessage(diagnosticError) ||
        'Участника не удалось вернуть в чат: MAX отклонил действие. Проверьте тип чата, статус участника и права бота.'
      );
    }

    if (maxApiMessage) {
      return 'Участника не удалось вернуть в чат: MAX отклонил действие. Проверьте тип чата, статус участника и права бота.';
    }

    return 'Участника не удалось вернуть в чат: MAX отклонил действие. Проверьте тип чата, статус участника и права бота.';
  }

  private throwManualModerationTransientMaxError(error: unknown): void {
    if (!this.isManualModerationTransientMaxError(error)) {
      return;
    }

    const transientError = new ServiceUnavailableException(
      'MAX API временно недоступен. Действие не выполнено; повторите через несколько секунд.',
    );
    throw this.preserveMemberMutationOutcome(error, transientError);
  }

  private preserveMemberMutationOutcome<T extends Error>(source: unknown, target: T): T {
    (target as T & { cause?: unknown }).cause = source;
    if (wasMaxMemberMutationConfirmed(source)) {
      return markMaxMemberMutationConfirmed(target) as T;
    }
    if (wasMaxMemberMutationAttempted(source)) {
      return markMaxMemberMutationAttempted(target) as T;
    }
    return target;
  }

  private isManualModerationTransientMaxError(error: unknown): boolean {
    return isManualModerationTransientMaxError(error);
  }

  private isAmbiguousMaxMemberModerationError(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return (
      normalized.includes('already been deleted') ||
      normalized.includes('do not have sufficient rights')
    );
  }

  private extractHttpErrorMessage(error: unknown): string {
    return extractHttpErrorMessage(error);
  }

  private isAddRemoveMembersPermission(permission: string): boolean {
    const normalized = permission
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, '_');
    return (
      normalized === 'add_remove_members' ||
      normalized === 'can_add_remove_members' ||
      normalized === 'remove_members' ||
      normalized === 'can_remove_members' ||
      normalized === 'manage_members' ||
      normalized === 'can_manage_members' ||
      normalized === 'kick_members' ||
      normalized === 'can_kick_members' ||
      normalized === 'ban_members' ||
      normalized === 'can_ban_members' ||
      normalized === 'ban_users' ||
      normalized === 'can_ban_users' ||
      normalized === 'delete_members' ||
      normalized === 'can_delete_members'
    );
  }

  private normalizeStoredModerationUserId(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private async upsertAdminGlobalSpammerExemption(
    adminUserId: string,
    targetUserId: string,
    sourceChatId: string,
  ): Promise<void> {
    const normalizedAdminUserId = this.normalizeStoredModerationUserId(adminUserId);
    const normalizedTargetUserId = this.normalizeStoredModerationUserId(targetUserId);
    if (!normalizedAdminUserId || !normalizedTargetUserId) {
      return;
    }

    await this.prisma.adminGlobalSpammerExemption.upsert({
      where: {
        adminUserId_userId: {
          adminUserId: normalizedAdminUserId,
          userId: normalizedTargetUserId,
        },
      },
      create: {
        adminUserId: normalizedAdminUserId,
        userId: normalizedTargetUserId,
        sourceChatId,
        decision: 'ALLOW',
        reason: 'MANUAL_UNBAN',
      },
      update: {
        sourceChatId,
        decision: 'ALLOW',
        reason: 'MANUAL_UNBAN',
      },
    });

    await this.globalSpammerIntelligence?.recordLocalAdminDecision({
      chatId: sourceChatId,
      userId: normalizedTargetUserId,
      reviewerUserId: normalizedAdminUserId,
      decision: 'ALLOW',
      reason: 'MANUAL_UNBAN',
    });
  }

  private async deleteAdminGlobalSpammerExemption(
    adminUserId: string,
    targetUserId: string,
  ): Promise<void> {
    const normalizedAdminUserId = this.normalizeStoredModerationUserId(adminUserId);
    const normalizedTargetUserId = this.normalizeStoredModerationUserId(targetUserId);
    if (!normalizedAdminUserId || !normalizedTargetUserId) {
      return;
    }

    await this.prisma.adminGlobalSpammerExemption.deleteMany({
      where: {
        adminUserId: normalizedAdminUserId,
        userId: normalizedTargetUserId,
      },
    });
  }

  private async resetDuplicateModerationState(chatId: string, targetUserId: string): Promise<void> {
    // FLAG: A per-author cutoff fences current history, queued media and immutable bindings.
    // Shared IMAGE originals owned by other participants remain intact.
    await this.redisCounter?.resetDuplicateWindow?.(chatId, targetUserId);

    const deleteKeysByPattern = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.deleteKeysByPattern;
    if (typeof deleteKeysByPattern !== 'function') {
      return;
    }

    try {
      await Promise.all([
        deleteKeysByPattern.call(
          this.redisCounter,
          buildDuplicateUserPattern(chatId, targetUserId),
        ),
        deleteKeysByPattern.call(
          this.redisCounter,
          buildModerationEscalationCounterPattern(chatId, targetUserId),
        ),
      ]);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId: targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to reset cached moderation state after manual release',
      );
    }
  }

  private async syncManualActiveMuteRuntimeState(params: {
    chatId: string;
    targetUserId: string;
    ruleCode: 'MANUAL_MUTE' | 'MANUAL_UNMUTE' | 'MANUAL_BAN' | 'MANUAL_UNBAN';
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    const cacheKey = buildActiveMuteStateKey(params.chatId, params.targetUserId);
    if (params.ruleCode === 'MANUAL_MUTE') {
      const mutePermanent = params.metadata.mutePermanent === true;
      const muteDurationHours = params.metadata.muteDurationHours;
      const muteExpiresAt = params.metadata.muteExpiresAt;
      if (mutePermanent) {
        try {
          await setStringWithTtl.call(
            this.redisCounter,
            cacheKey,
            JSON.stringify({
              eventId: `manual:${params.chatId}:${params.targetUserId}:permanent:${Date.now()}`,
              issuedAt: new Date().toISOString(),
              expiresAt: null,
              durationHours: null,
              permanent: true,
            } satisfies CachedActiveMuteState),
            PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC,
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: params.chatId,
              userId: params.targetUserId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to cache permanent manual active mute runtime state',
          );
        }
        return;
      }

      const expiresAtMs =
        typeof muteExpiresAt === 'string' ? Date.parse(muteExpiresAt) : Number.NaN;
      if (
        typeof muteDurationHours !== 'number' ||
        !Number.isInteger(muteDurationHours) ||
        muteDurationHours < 1 ||
        !Number.isFinite(expiresAtMs)
      ) {
        return;
      }

      const ttlSec = Math.ceil((expiresAtMs - Date.now()) / 1_000) + ACTIVE_MUTE_CACHE_SLACK_SEC;
      if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
        return;
      }

      try {
        await setStringWithTtl.call(
          this.redisCounter,
          cacheKey,
          JSON.stringify({
            eventId: `manual:${params.chatId}:${params.targetUserId}:${expiresAtMs}`,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(expiresAtMs).toISOString(),
            durationHours: muteDurationHours,
            permanent: false,
          } satisfies CachedActiveMuteState),
          ttlSec,
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: params.chatId,
            userId: params.targetUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to cache manual active mute runtime state',
        );
      }
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        cacheKey,
        '0',
        ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clear manual active mute runtime state',
      );
    }
  }

  private async recordManualModerationAction(params: {
    chatId: string;
    targetUserId: string;
    targetDisplayName?: string | null;
    actorUserId: string;
    ruleCode: 'MANUAL_MUTE' | 'MANUAL_UNMUTE' | 'MANUAL_BAN' | 'MANUAL_UNBAN';
    sanctionAction: SanctionAction;
    auditAction:
      | 'MANUAL_MUTE_MEMBER'
      | 'MANUAL_UNMUTE_MEMBER'
      | 'MANUAL_BAN_MEMBER'
      | 'MANUAL_UNBAN_MEMBER';
    metadata: Record<string, unknown>;
    auditPayload: Record<string, unknown>;
    fanoutLedger?: {
      operationKey: string;
      lockToken: string;
      botId?: string | null;
      executionMode?: string | null;
      metadata?: Prisma.InputJsonValue | null;
    };
  }): Promise<string> {
    const {
      chatId,
      targetUserId,
      targetDisplayName,
      actorUserId,
      ruleCode,
      sanctionAction,
      auditAction,
      metadata,
      auditPayload,
      fanoutLedger,
    } = params;
    const eventMetadata = {
      ...metadata,
      ...(this.readTrimmedString(targetDisplayName)
        ? { targetDisplayName: this.readTrimmedString(targetDisplayName) }
        : {}),
    };
    let moderationEventId: string | null = null;

    if (fanoutLedger) {
      await this.prisma.$transaction(async (tx) => {
        const moderationEvent = await tx.moderationEvent.create({
          data: {
            chatId,
            userId: targetUserId,
            eventType: EventType.MEMBER_ACTION,
            ruleCode,
            action: sanctionAction,
            operator: Operator.ADMIN,
            metadata: eventMetadata as Prisma.InputJsonValue,
          },
        });
        moderationEventId = this.readTrimmedString(moderationEvent?.id);
        const auditLog = await tx.auditLog.create({
          data: {
            chatId,
            actorUserId,
            action: auditAction,
            payload: auditPayload as Prisma.InputJsonValue,
          },
        });
        const ledgerUpdate = await tx.manualModerationFanoutLedgerEntry.updateMany({
          where: {
            operationKey: fanoutLedger.operationKey,
            lockToken: fanoutLedger.lockToken,
            status: {
              in: [
                PrismaManualModerationFanoutLedgerStatus.IN_PROGRESS,
                PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS,
              ],
            },
          },
          data: {
            status: PrismaManualModerationFanoutLedgerStatus.SUCCEEDED,
            botId: fanoutLedger.botId ?? undefined,
            executionMode: fanoutLedger.executionMode ?? undefined,
            moderationEventId:
              typeof moderationEvent?.id === 'string' ? moderationEvent.id : undefined,
            auditLogId: typeof auditLog?.id === 'string' ? auditLog.id : undefined,
            lastError: null,
            lastStatusCode: null,
            lastErrorCode: null,
            terminal: true,
            lockedAt: null,
            lockToken: null,
            metadata: fanoutLedger.metadata ?? undefined,
          },
        });
        if (ledgerUpdate.count !== 1) {
          throw new ModerationSanctionStateChangedError();
        }
      });
    } else {
      const [moderationEvent] = await this.prisma.$transaction([
        this.prisma.moderationEvent.create({
          data: {
            chatId,
            userId: targetUserId,
            eventType: EventType.MEMBER_ACTION,
            ruleCode,
            action: sanctionAction,
            operator: Operator.ADMIN,
            metadata: eventMetadata as Prisma.InputJsonValue,
          },
        }),
        this.prisma.auditLog.create({
          data: {
            chatId,
            actorUserId,
            action: auditAction,
            payload: auditPayload as Prisma.InputJsonValue,
          },
        }),
      ]);
      moderationEventId = this.readTrimmedString(moderationEvent?.id);
    }
    await this.syncManualActiveMuteRuntimeState({
      chatId,
      targetUserId,
      ruleCode,
      metadata: eventMetadata,
    });
    this.invalidateLogsDashboardResponseCache(chatId);
    this.invalidateModerationFeedPageCache(chatId);
    this.invalidateChatParticipantsPageCache(chatId);
    if (!moderationEventId) {
      throw new Error('Manual moderation event was persisted without an ID');
    }
    return moderationEventId;
  }

  async getEvents(chatId: string, user: AuthUser, query: unknown): Promise<ModerationEvent[]> {
    const startedAtMs = Date.now();
    await this.assertReadOnlyChatAdmin(chatId, user.userId);
    const adminCheckedAtMs = Date.now();
    const parsed = dateRangeQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const from = parsed.data.from ? new Date(parsed.data.from) : undefined;
    const to = parsed.data.to ? new Date(parsed.data.to) : undefined;

    const rows = await this.prisma.moderationEvent.findMany({
      where: {
        chatId,
        ruleCode: { not: SANCTION_STATE_FENCE_RULE_CODE },
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (parsed.data.page - 1) * parsed.data.limit,
      take: parsed.data.limit,
    });
    const finishedAtMs = Date.now();
    const totalMs = finishedAtMs - startedAtMs;
    if (totalMs >= 1_500) {
      this.logger.warn(
        {
          chatId,
          userId: user.userId,
          totalMs,
          adminCheckMs: adminCheckedAtMs - startedAtMs,
          queryMs: finishedAtMs - adminCheckedAtMs,
          page: parsed.data.page,
          limit: parsed.data.limit,
        },
        'Slow moderation events query completed',
      );
    }

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      userId: row.userId,
      eventType: row.eventType,
      ruleCode: row.ruleCode,
      action: row.action,
      maskedExcerpt: row.maskedExcerpt,
      score: row.score,
      metadata:
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
      createdAt: row.createdAt.toISOString(),
      operator: row.operator,
    }));
  }

  async addAdmin(chatId: string, user: AuthUser, body: unknown) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addAdminRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const resolvedBotId = await this.resolveBotAssignment(chatId);

    await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: `Chat ${chatId}`,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
      },
      update: {},
    });

    await this.prisma.chatAdminAllowlist.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId: parsed.data.userId,
        },
      },
      create: {
        chatId,
        userId: parsed.data.userId,
      },
      update: {},
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'ADD_ADMIN',
        payload: {
          userId: parsed.data.userId,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeAdmin(chatId: string, user: AuthUser, targetUserId: string) {
    await this.assertChatAdmin(chatId, user.userId);

    await this.prisma.chatAdminAllowlist.delete({
      where: {
        chatId_userId: {
          chatId,
          userId: targetUserId,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: 'REMOVE_ADMIN',
        payload: {
          userId: targetUserId,
        },
      },
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async getDomainAllowlist(chatId: string, user: AuthUser): Promise<string[]> {
    return this.domainAllowlistRuntime.getDomainAllowlist(chatId, user);
  }

  async getDomainAllowlistDetails(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<DomainAllowlistEntry[]> {
    return this.domainAllowlistRuntime.getDomainAllowlistDetails(chatId, user, options);
  }

  async addDomain(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    return this.domainAllowlistRuntime.addDomain(chatId, user, body, source);
  }

  async removeDomain(
    chatId: string,
    user: AuthUser,
    domain: string,
    source: AdminActionSource = 'miniapp',
  ) {
    return this.domainAllowlistRuntime.removeDomain(chatId, user, domain, source);
  }

  async scheduleDomainRemoval(
    chatId: string,
    user: AuthUser,
    domain: string,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    return this.domainAllowlistRuntime.scheduleDomainRemoval(chatId, user, domain, body, source);
  }

  async assertChatAdmin(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType | null = null,
    options: AssertChatAdminOptions = {},
  ) {
    const isReadOnlyValidation = options.syncPersistedAccess === false;
    const access = await this.resolveUserAndBotAdminAccess(chatId, userId, {
      bypassNegativeCache: true,
      bypassPositiveCache: options.bypassPositiveCache ?? !isReadOnlyValidation,
      ...(entityType ? { entityType } : {}),
      trafficClass: options.trafficClass,
      timeoutMs: options.timeoutMs,
      allowPersistedFallback: options.allowPersistedFallback ?? isReadOnlyValidation,
    });
    if (access.status === 'denied') {
      if (access.reason === 'bot_not_admin') {
        throw new ForbiddenException(
          'Действие недоступно: бот больше не состоит в этом чате MAX или утратил права администратора.',
        );
      }

      throw new ForbiddenException('Пользователь не является администратором чата.');
    }

    if (access.status === 'unknown') {
      throw new ServiceUnavailableException(
        'Не удалось проверить права администратора в MAX. Повторите попытку.',
      );
    }

    if (access.status === 'throttled') {
      throw new ServiceUnavailableException(
        'MAX API временно ограничил проверку прав администратора. Повторите попытку.',
      );
    }

    if (options.syncPersistedAccess !== false) {
      if (access.source === 'remote' && !access.probeStartedAt) {
        throw new ServiceUnavailableException(
          'Не удалось зафиксировать момент проверки прав администратора в MAX. Повторите попытку.',
        );
      }
      const persistedChat = await this.upsertUserChatAccess(chatId, userId, null, entityType, {
        ...(access.source === 'remote'
          ? {
              accessProbeStartedAt: access.probeStartedAt as Date,
            }
          : {}),
      });
      if (!persistedChat) {
        throw new ServiceUnavailableException(
          'Проверка прав администратора устарела из-за более нового события MAX. Повторите попытку.',
        );
      }
    } else if (access.source === 'remote') {
      this.scheduleAdminAccessValidationRosterSync(chatId, entityType);
    }
  }

  async assertManagedEntityAdminAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void> {
    await this.managedEntitiesRuntime.assertManagedEntityAdminAccess(chatId, userId, entityType);
  }

  async assertManagedEntityReadAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions = {},
  ): Promise<void> {
    await this.managedEntitiesRuntime.assertManagedEntityReadAccess(
      chatId,
      userId,
      entityType,
      options,
    );
  }

  async resolveUserProfilesForAdminSurface(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options: ResolveUserProfilesOptions = {},
  ): Promise<Map<string, ResolvedUserProfile>> {
    return this.resolveUserProfiles(chatId, entityType, userIds, options);
  }

  async resolveChatSettingsReadBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveChatBotIdForRead(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  async resolveChatSettingsWriteBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveManualActionBotAssignment(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  async assertChatSettingsBotCapabilities(
    chatId: string,
    requirements: readonly ChatSettingsBotCapabilityRequirement[],
    options: { forceLive?: boolean } = {},
  ): Promise<void> {
    return assertAdminSettingsBotCapabilities(
      {
        maxBotLinkService: this.maxBotLinkService,
        maxBotExecutionPlanner: this.maxBotExecutionPlanner,
      },
      chatId,
      requirements,
      options,
    );
  }

  async resolveChannelSettingsReadBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveChatBotIdForRead(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  async resolveChannelSettingsWriteBotAssignmentData(
    chatId: string,
  ): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveManualActionBotAssignment(
      chatId,
      ChatEntityType.CHANNEL,
    );
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  async resolveChatRulesActionBotId(chatId: string): Promise<string | undefined> {
    return this.resolveManualActionBotAssignment(chatId);
  }

  async resolveChannelEngagementActionBotId(chatId: string): Promise<string | undefined> {
    return this.resolveSendActionBotAssignment(chatId, ChatEntityType.CHANNEL);
  }

  async resolveChannelEngagementEditBotId(chatId: string): Promise<string | undefined> {
    const route = await this.resolveUnifiedBotRoute({
      purpose: 'moderation_action',
      chatId,
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    if (route) {
      if (route.botId) {
        return route.botId;
      }
      throw new ForbiddenException(
        'Не найден бот MAX с подтвержденным правом обновить опубликованный пост канала.',
      );
    }

    return this.resolveManualModerationActionBotAssignment(chatId, 'delete_message', {
      entityType: ChatEntityType.CHANNEL,
    });
  }

  async resolveChannelPollBotId(chatId: string): Promise<string | undefined> {
    const resolver = this.maxBotLinkService as unknown as {
      resolveBotIdForManagedPoll?: (params: { chatId: string }) => Promise<string | null>;
    };
    if (typeof resolver?.resolveBotIdForManagedPoll !== 'function') {
      throw new ServiceUnavailableException('Маршрутизация бота для опроса временно недоступна.');
    }

    const botId = await resolver.resolveBotIdForManagedPoll({ chatId });
    if (botId) {
      return botId;
    }
    throw new ForbiddenException(
      'Не найден бот MAX, который может опубликовать и обновлять опрос в канале.',
    );
  }

  async resolveChatPollBotId(chatId: string): Promise<string | undefined> {
    const resolver = this.maxBotLinkService as unknown as {
      resolveBotIdForManagedPoll?: (params: { chatId: string }) => Promise<string | null>;
    };
    if (typeof resolver?.resolveBotIdForManagedPoll !== 'function') {
      throw new ServiceUnavailableException('Маршрутизация бота для опроса временно недоступна.');
    }

    const botId = await resolver.resolveBotIdForManagedPoll({ chatId });
    if (botId) {
      return botId;
    }
    throw new ForbiddenException(
      'Не найден бот MAX, который может опубликовать и обновлять опрос в чате.',
    );
  }

  normalizeChatSettingsForApply(sourceChatId: string, settings: ChatSettings): ChatSettings {
    return normalizeChatSettings(settings, undefined, sourceChatId);
  }

  async resolveSettingsApplyTargetChatsForSettings(
    sourceChatId: string,
    user: AuthUser,
    target: ApplySettingsTarget,
  ): Promise<ChatSummary[]> {
    const targetChats = await this.resolveSettingsApplyTargetChats(sourceChatId, user, target);
    const checkedChatIds = new Set<string>([sourceChatId]);
    for (const chat of targetChats) {
      if (checkedChatIds.has(chat.id)) {
        continue;
      }
      await this.assertManagedEntityAdminAccess(chat.id, user.userId, 'chat');
      checkedChatIds.add(chat.id);
    }
    return targetChats;
  }

  async resolveSettingsApplyBotAssignmentData(chatId: string): Promise<ResolvedBotAssignmentData> {
    const resolvedBotId = await this.resolveBotAssignment(chatId);
    return this.buildResolvedBotAssignmentData(resolvedBotId);
  }

  isRequiredSubscriptionCurrentlyActiveForSettings(settings: ChatSettings): boolean {
    return isRequiredSubscriptionCurrentlyActive(settings);
  }

  scheduleApplySettingsToAllReadinessRefreshForSettings(params: {
    chatIds: readonly string[];
    shouldRefreshRequiredSubscription: boolean;
    requiredSubscriptionChannelIds: readonly string[];
  }): void {
    if (!this.maxBotExecutionPlanner) {
      return;
    }
    void this.refreshApplySettingsToAllReadiness(params).catch((error: unknown) => {
      this.logger.warn(
        {
          chats: params.chatIds.length,
          requiredSubscriptionChannels: params.requiredSubscriptionChannelIds.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh apply-to-all readiness snapshots in background',
      );
    });
  }

  async syncDomainAllowlistToChatsForSettings(
    sourceChatId: string,
    targetChatIds: readonly string[],
  ): Promise<void> {
    await this.domainAllowlistRuntime.syncDomainAllowlistToChatsForSettings(
      sourceChatId,
      targetChatIds,
    );
  }

  async resolveManagedEntityHeaderReadBotId(chatId: string): Promise<string | undefined> {
    return this.managedEntitiesRuntime.resolveManagedEntityHeaderReadBotId(chatId);
  }

  async attachManagedEntityHeaderBotAssignmentsForManagedEntities(
    header: ManagedEntityHeader,
  ): Promise<ManagedEntityHeader> {
    return this.managedEntitiesRuntime.attachManagedEntityHeaderBotAssignmentsForManagedEntities(
      header,
    );
  }

  buildChannelEngagementDialogArtifacts(
    params: BuildChannelEngagementDialogArtifactsParams,
  ): ChannelEngagementDialogArtifacts {
    const commentsUrl = this.dialogLinkHelper.buildChannelDialogLaunchUrl(
      params.chatId,
      'comments',
      params.threadId,
      params.botId,
    );
    const suggestPayload = this.dialogLinkHelper.buildChannelSuggestionStartPayload(
      params.chatId,
      params.threadId,
      params.botId,
    );
    const suggestLaunchUrl = this.dialogLinkHelper.buildChannelDialogLaunchUrl(
      params.chatId,
      'suggest',
      params.threadId,
      params.botId,
    );
    const suggestUrl =
      params.suggestionEntryMode === 'MINIAPP'
        ? suggestLaunchUrl
        : (this.dialogLinkHelper.buildBotStartUrl(suggestPayload, params.botId) ??
          suggestLaunchUrl);

    return {
      commentsUrl,
      suggestPayload,
      suggestUrl,
      commentsButton: this.buildChannelDialogButton(
        params.chatId,
        'comments',
        params.threadId,
        params.formattedCommentsButtonText,
        params.botId,
      ),
      suggestButton: this.buildChannelDialogButton(
        params.chatId,
        'suggest',
        params.threadId,
        params.suggestButtonText,
        params.botId,
        params.suggestionEntryMode,
      ),
    };
  }

  async buildAutofilledChatRulesTextFromCurrentSettings(
    chatId: string,
    user: AuthUser,
  ): Promise<string> {
    return this.chatRulesTextRuntime.buildAutofilledRulesTextFromCurrentSettings(chatId, user);
  }

  async buildFormattedChatRulesPublicationText(
    chatId: string,
    sourceText: string,
    options: {
      textFormat: ChatRules['textFormat'];
      adminContactButtonEnabled: boolean;
      adminContactButtonUrl: string;
    },
  ): Promise<{
    text: string;
    textFormat: MaxSendMessageOptions['textFormat'];
  }> {
    return this.chatRulesTextRuntime.buildFormattedRulesPublicationText(
      chatId,
      sourceText,
      options,
    );
  }

  async sendPublishedChatRulesPrivateConfirmation(
    user: AuthUser,
    publishedUrl: string | null,
    operation: 'created' | 'updated' = 'created',
  ): Promise<void> {
    await this.sendRulesPublishedPrivateConfirmation(user, publishedUrl, operation);
  }

  async assertRequiredSubscriptionSettingsForChatSettings(
    settings: ChatSettings,
  ): Promise<ChatSettings> {
    return this.assertRequiredSubscriptionSettings(settings);
  }

  async refreshChatSettingsExecutionReadiness(
    chatId: string,
    settings: ChatSettings,
  ): Promise<void> {
    await this.refreshExecutionReadinessAfterChatSettingsUpdate(chatId, settings);
  }

  async refreshChannelSettingsExecutionReadiness(chatId: string): Promise<void> {
    await refreshBots(
      this.maxBotExecutionPlanner,
      this.logger,
      chatId,
      'channel',
      'channel settings update',
    );
  }

  async resolveRequiredSubscriptionChannelHeadersForSettings(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]> {
    return this.resolveRequiredSubscriptionChannelHeaders(channelIds);
  }

  private async assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType | null = null,
    options: {
      forceRemote?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    await this.assertChatAdmin(chatId, userId, entityType, {
      syncPersistedAccess: false,
      trafficClass: options.forceRemote === true ? 'interactive' : undefined,
      timeoutMs: options.timeoutMs,
      allowPersistedFallback: false,
      bypassPositiveCache: true,
    });
  }

  private scheduleAdminAccessValidationRosterSync(
    chatId: string,
    entityType: ManagedEntityType | null,
  ): void {
    if (typeof this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync !== 'function') {
      return;
    }

    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const now = Date.now();
    const lastScheduledAt =
      this.adminAccessValidationRosterSyncScheduledAtMs.get(normalizedChatId) ?? 0;
    if (now - lastScheduledAt < ADMIN_ACCESS_VALIDATION_ROSTER_SYNC_THROTTLE_MS) {
      return;
    }
    this.adminAccessValidationRosterSyncScheduledAtMs.set(normalizedChatId, now);

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId: normalizedChatId,
        entityType,
        source: 'admin_access_validation',
        retryUntilMs: null,
      })
      .catch((error: unknown) => {
        this.adminAccessValidationRosterSyncScheduledAtMs.delete(normalizedChatId);
        this.logger.warn(
          {
            chatId: normalizedChatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule admin roster sync after read-only admin validation',
        );
      });
  }

  private resolveLogsDashboardFrom(range: LogsDashboardRange, to: Date): Date {
    return this.logsDashboardRuntime.resolveLogsDashboardFrom(range, to);
  }

  private buildParticipantSeries(
    ...args: Parameters<AdminChannelStatsRuntime['buildParticipantSeries']>
  ): ReturnType<AdminChannelStatsRuntime['buildParticipantSeries']> {
    return this.channelStatsRuntime.buildParticipantSeries(...args);
  }

  private buildChannelStatsDailySummary(
    ...args: Parameters<AdminChannelStatsRuntime['buildChannelStatsDailySummary']>
  ): ReturnType<AdminChannelStatsRuntime['buildChannelStatsDailySummary']> {
    return this.channelStatsRuntime.buildChannelStatsDailySummary(...args);
  }

  private buildAverageViewsSeriesFromPostMetrics(
    ...args: Parameters<AdminChannelStatsRuntime['buildAverageViewsSeriesFromPostMetrics']>
  ): ReturnType<AdminChannelStatsRuntime['buildAverageViewsSeriesFromPostMetrics']> {
    return this.channelStatsRuntime.buildAverageViewsSeriesFromPostMetrics(...args);
  }

  private toSafeInteger(value: unknown) {
    return toSafeInteger(value);
  }

  private toIsoString(value: unknown) {
    return toIsoString(value);
  }

  private async resolveUserDisplayNames(
    chatId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.$queryRaw<
      Array<{ user_id: string | null; sender_name: string | null }>
    >`
      SELECT DISTINCT ON (user_id)
        user_id,
        sender_name
      FROM (
        SELECT
          user_id,
          display_name AS sender_name,
          observed_at AS event_at,
          0 AS source_priority
        FROM chat_user_display_names
        WHERE chat_id = ${chatId}
          AND user_id IN (${Prisma.join(normalizedUserIds)})
          AND COALESCE(BTRIM(display_name), '') <> ''

        UNION ALL

        SELECT
          user_id,
          sender_name,
          event_at,
          1 AS source_priority
        FROM chat_membership_activity_feed_items
        WHERE chat_id = ${chatId}
          AND user_id IN (${Prisma.join(normalizedUserIds)})
          AND COALESCE(BTRIM(sender_name), '') <> ''

        UNION ALL

        SELECT
          NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') AS user_id,
          NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') AS sender_name,
          created_at AS event_at,
          2 AS source_priority
        FROM webhook_events
        WHERE NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') = ${chatId}
          AND NULLIF(BTRIM(normalized_payload->'message'->>'senderId'), '') IN (${Prisma.join(
            normalizedUserIds,
          )})
          AND NULLIF(BTRIM(normalized_payload->'message'->>'senderName'), '') IS NOT NULL
          AND normalized_payload->>'type' IN (${Prisma.join(LOCAL_USER_DISPLAY_NAME_EVENT_TYPES)})
      ) local_name_events
      ORDER BY user_id, source_priority, event_at DESC
    `;

    const byUserId = new Map<string, string>();
    for (const row of Array.isArray(rows) ? rows : []) {
      const userId = typeof row.user_id === 'string' ? row.user_id.trim() : '';
      const senderName = typeof row.sender_name === 'string' ? row.sender_name.trim() : '';
      if (!userId || !senderName || byUserId.has(userId)) {
        continue;
      }
      byUserId.set(userId, senderName);
    }

    return byUserId;
  }

  private async resolveManualModerationTargetDisplayName(
    chatId: string,
    targetUserId: string,
    options: {
      botId?: string | null;
      allowRemoteLookup?: boolean;
    } = {},
  ): Promise<string | null> {
    const normalizedChatId = chatId.trim();
    const normalizedTargetUserId = targetUserId.trim();
    if (!normalizedChatId || !normalizedTargetUserId) {
      return null;
    }

    try {
      const localDisplayNames = await this.resolveUserDisplayNames(normalizedChatId, [
        normalizedTargetUserId,
      ]);
      const localDisplayName = normalizeMaxUserDisplayName(
        localDisplayNames.get(normalizedTargetUserId),
        normalizedTargetUserId,
      );
      if (localDisplayName) {
        return localDisplayName;
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          userId: normalizedTargetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve local display name for manual moderation target',
      );
    }

    if (options.allowRemoteLookup === false) {
      return null;
    }

    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    if (typeof loadProfiles !== 'function') {
      return null;
    }

    try {
      const profiles = await loadProfiles(normalizedChatId, [normalizedTargetUserId], {
        trafficClass: 'background',
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(options.botId ? { botId: options.botId } : {}),
      });
      const profile = profiles.get(normalizedTargetUserId);
      const displayName = normalizeMaxUserDisplayName(profile?.displayName, normalizedTargetUserId);
      if (displayName) {
        return displayName;
      }

      const username = this.readTrimmedString(profile?.username);
      return username ? `@${username.replace(/^@+/u, '')}` : null;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          userId: normalizedTargetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve remote display name for manual moderation target',
      );
      return null;
    }
  }

  private async resolveUserProfiles(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options: ResolveUserProfilesOptions = {},
  ): Promise<Map<string, ResolvedUserProfile>> {
    const allowRemoteLookup = options.allowRemoteLookup !== false;
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const profiles = new Map<string, ResolvedUserProfile>();
    const pendingByUserId = new Map<string, Promise<ResolvedUserProfile>>();
    const nowMs = Date.now();
    const missingUserIds: string[] = [];
    const routeBotId =
      this.readTrimmedString(options.botId) ??
      (await this.resolveBackgroundReadBotAssignment(chatId).catch(() => undefined)) ??
      null;
    const cacheOptions: ResolveUserProfilesOptions = {
      ...options,
      ...(routeBotId ? { botId: routeBotId } : {}),
    };

    for (const userId of normalizedUserIds) {
      const remoteCacheKey = buildResolvedUserProfileCacheKey(chatId, entityType, userId, {
        allowRemoteLookup: true,
        ...(routeBotId ? { botId: routeBotId } : {}),
      });
      const localCacheKey = buildResolvedUserProfileCacheKey(chatId, entityType, userId, {
        allowRemoteLookup: false,
        ...(routeBotId ? { botId: routeBotId } : {}),
      });
      const cached = allowRemoteLookup
        ? this.resolvedUserProfileCache.get(remoteCacheKey)
        : this.resolvedUserProfileCache.get(localCacheKey);
      if (cached && cached.expiresAtMs > nowMs) {
        pendingByUserId.set(userId, cached.promise);
        continue;
      }

      if (allowRemoteLookup) {
        this.resolvedUserProfileCache.delete(remoteCacheKey);
      } else {
        this.resolvedUserProfileCache.delete(localCacheKey);
      }
      missingUserIds.push(userId);
    }

    if (missingUserIds.length > 0) {
      const batchPromise = this.loadResolvedUserProfiles(
        chatId,
        entityType,
        missingUserIds,
        cacheOptions,
      ).catch((error: unknown) => {
        for (const userId of missingUserIds) {
          const cacheKey = buildResolvedUserProfileCacheKey(
            chatId,
            entityType,
            userId,
            cacheOptions,
          );
          const current = this.resolvedUserProfileCache.get(cacheKey);
          if (current?.promise === pendingByUserId.get(userId)) {
            this.resolvedUserProfileCache.delete(cacheKey);
          }
        }
        throw error;
      });

      for (const userId of missingUserIds) {
        const cacheKey = buildResolvedUserProfileCacheKey(chatId, entityType, userId, cacheOptions);
        const pendingProfile = batchPromise.then(
          (batch) =>
            batch.get(userId) ?? {
              displayName: null,
              avatarUrl: null,
              profileUrl: null,
              profileHandoffUrl: this.buildProfileMentionHandoffUrl(
                chatId,
                entityType,
                userId,
                null,
                routeBotId,
              ),
            },
        );
        this.resolvedUserProfileCache.set(cacheKey, {
          expiresAtMs: nowMs + RESOLVED_USER_PROFILE_CACHE_TTL_MS,
          promise: pendingProfile,
        });
        pendingByUserId.set(userId, pendingProfile);
      }
    }

    for (const userId of normalizedUserIds) {
      const pendingProfile = pendingByUserId.get(userId);
      if (!pendingProfile) {
        continue;
      }
      profiles.set(userId, await pendingProfile);
    }

    return profiles;
  }

  private async loadResolvedUserProfiles(
    chatId: string,
    entityType: ManagedEntityType,
    userIds: readonly string[],
    options: ResolveUserProfilesOptions = {},
  ): Promise<Map<string, ResolvedUserProfile>> {
    const allowRemoteLookup = options.allowRemoteLookup !== false;
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const displayNames = await this.resolveUserDisplayNames(chatId, normalizedUserIds);
    let chatMemberProfiles = new Map<
      string,
      {
        displayName: string | null;
        username: string | null;
        avatarUrl: string | null;
        profileUrl: string | null;
      }
    >();

    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    let resolvedBotId = this.readTrimmedString(options.botId);
    if (allowRemoteLookup && loadProfiles) {
      try {
        resolvedBotId =
          resolvedBotId ?? (await this.resolveBackgroundReadBotAssignment(chatId)) ?? null;
        chatMemberProfiles = await loadProfiles(chatId, normalizedUserIds, {
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
      } catch (error) {
        this.logger.warn(
          {
            chatId,
            userIds: normalizedUserIds,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve chat member profiles',
        );
      }
    }

    const profiles = new Map<string, ResolvedUserProfile>();
    for (const userId of normalizedUserIds) {
      const profile = chatMemberProfiles.get(userId);
      const username = this.readTrimmedString(profile?.username);
      const displayName =
        displayNames.get(userId) ?? this.readTrimmedString(profile?.displayName) ?? null;
      profiles.set(userId, {
        displayName,
        avatarUrl: this.readTrimmedString(profile?.avatarUrl) ?? null,
        profileUrl:
          this.normalizeMaxProfileUrl(this.readTrimmedString(profile?.profileUrl) ?? null) ??
          this.buildUserProfileUrl(username),
        profileHandoffUrl: this.buildProfileMentionHandoffUrl(
          chatId,
          entityType,
          userId,
          displayName,
          resolvedBotId,
        ),
      });
    }

    return profiles;
  }

  private buildUserProfileUrl(username: string | null): string | null {
    return buildUserProfileUrl(username);
  }

  private normalizeMaxProfileUrl(value: string | null): string | null {
    return normalizeMaxProfileUrl(value);
  }

  private normalizeLegacyProfileButtonUrl(url: string | null | undefined): string {
    return normalizeLegacyProfileButtonUrl(url);
  }

  private buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
    botId?: string | null,
  ): string | null {
    return buildProfileMentionHandoffUrl(
      this.dialogLinkHelper,
      chatId,
      entityType,
      userId,
      displayName,
      botId,
    );
  }

  private async getPublicChannelSettings(chatId: string): Promise<ChannelSettings> {
    return readPublicChannelSettingsValue(this.prisma, chatId);
  }

  private async getPublicChatCommentSettings(chatId: string): Promise<PublicChatCommentSettings> {
    return readPublicChatCommentSettingsValue(this.prisma, chatId);
  }

  private shouldIncludeChatCommentsButton(
    settings: Pick<ChatSettings, 'commentsEnabled' | 'commentsChatBroadcastsEnabled'>,
  ): boolean {
    return settings.commentsEnabled && settings.commentsChatBroadcastsEnabled;
  }

  private async assertChannelCommentAllowed(params: {
    chatId: string;
    threadId: string | null;
    authorUserId: string;
    text: string;
    settings: ChannelSettings;
  }): Promise<void> {
    const { chatId, threadId, authorUserId, text, settings } = params;

    if (settings.commentsBlockLinksEnabled && this.channelCommentContainsLink(text)) {
      throw new BadRequestException('Ссылки в комментариях отключены.');
    }

    const threadFilter = threadId
      ? {
          payload: {
            path: ['threadId'],
            equals: threadId,
          } satisfies Prisma.JsonFilter,
        }
      : {};

    const [recentThreadComments, recentOwnComments] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          ...threadFilter,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: CHANNEL_COMMENT_MAX_CONSECUTIVE,
      }),
      this.prisma.auditLog.findMany({
        where: {
          chatId,
          action: CHANNEL_DIALOG_ACTION_COMMENT,
          actorUserId: authorUserId,
          ...threadFilter,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 8,
      }),
    ]);

    if (
      settings.commentsLimitTwoInRowEnabled &&
      recentThreadComments.length >= CHANNEL_COMMENT_MAX_CONSECUTIVE &&
      recentThreadComments.every((row) => row.actorUserId === authorUserId)
    ) {
      throw new BadRequestException(
        'Нельзя оставлять больше двух комментариев подряд. Дайте другим ответить.',
      );
    }

    if (!settings.commentsAntiSpamEnabled) {
      return;
    }

    const normalizedCurrentText = this.normalizeChannelCommentText(text);
    const hasRecentDuplicate = recentOwnComments.some((row) => {
      if (Date.now() - row.createdAt.getTime() > CHANNEL_COMMENT_DUPLICATE_WINDOW_MS) {
        return false;
      }

      const payload = this.readObjectPayload(row.payload);
      const previousText = this.readTrimmedString(payload.text);
      return previousText
        ? this.normalizeChannelCommentText(previousText) === normalizedCurrentText
        : false;
    });

    if (hasRecentDuplicate) {
      throw new BadRequestException(
        'Одинаковые комментарии подряд отправлять нельзя. Напишите один комментарий без повтора.',
      );
    }
  }

  private mapChannelDialogAuditLog(
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date },
    fallbackType: ChannelDialogType,
    currentUserId?: string | null,
    adminUserIds?: ReadonlySet<string>,
  ): ChannelDialogMessage {
    return this.channelDialogMappingRuntime.mapChannelDialogAuditLog(
      row,
      fallbackType,
      currentUserId,
      adminUserIds,
    );
  }

  private readChannelDialogAttachmentAssets(value: unknown): ChannelDialogAttachmentAsset[] {
    return channelDialogValues.readChannelDialogAttachmentAssets(value);
  }

  private readChannelDialogAttachmentAsset(value: unknown): ChannelDialogAttachmentAsset | null {
    return channelDialogValues.readChannelDialogAttachmentAsset(value);
  }

  private buildChannelDialogCommentAttachments(
    attachments: ChannelDialogAttachmentAsset[],
  ): ChannelDialogAttachment[] {
    return channelDialogValues.buildChannelDialogCommentAttachments(attachments);
  }

  private mapChannelDialogAttachmentAsset(
    attachment: ChannelDialogAttachmentAsset,
  ): ChannelDialogAttachment | null {
    return channelDialogValues.mapChannelDialogAttachmentAsset(attachment);
  }

  private buildChannelDialogReplyPreviewText(payload: Record<string, unknown>): string {
    const text = this.readTrimmedString(payload.text);
    if (text) {
      return text;
    }

    return this.summarizeChannelDialogCommentAttachments(
      this.buildChannelDialogCommentAttachments(
        this.readChannelDialogAttachmentAssets(payload.attachments),
      ),
    );
  }

  private summarizeChannelDialogCommentAttachments(
    attachments: Pick<ChannelDialogAttachment, 'kind' | 'fileName'>[],
  ): string {
    if (attachments.length === 0) {
      return '';
    }

    const imageCount = attachments.filter((attachment) => attachment.kind === 'image').length;
    const files = attachments.filter((attachment) => attachment.kind === 'file');

    if (imageCount > 0 && files.length === 0) {
      if (imageCount > 1) {
        return `Фото · ${imageCount} шт.`;
      }
      const fileName = attachments
        .find((attachment) => attachment.kind === 'image')
        ?.fileName?.trim();
      return fileName ? `Фото · ${fileName}` : 'Фото';
    }

    if (files.length > 0 && imageCount === 0) {
      if (files.length > 1) {
        return `Файлы · ${files.length} шт.`;
      }
      const fileName = files[0]?.fileName?.trim();
      return fileName ? `Файл · ${fileName}` : 'Файл';
    }

    return `Вложения · ${attachments.length} шт.`;
  }

  private readChannelSuggestionImageAssets(value: unknown): ChannelSuggestionImageAsset[] {
    return channelDialogValues.readChannelSuggestionImageAssets(value);
  }

  private readChannelSuggestionImageAsset(value: unknown): ChannelSuggestionImageAsset | null {
    return channelDialogValues.readChannelSuggestionImageAsset(value);
  }

  private readChannelSuggestionTextMarkup(value: unknown): ChannelSuggestionTextMarkup[] {
    return channelDialogValues.readChannelSuggestionTextMarkup(value);
  }

  private readChannelSuggestionTextMarkupItem(value: unknown): ChannelSuggestionTextMarkup | null {
    return channelDialogValues.readChannelSuggestionTextMarkupItem(value);
  }

  private normalizeChannelSuggestionImages(params: {
    images?: ChannelSuggestionImageAsset[] | null;
    imageBase64?: string | null;
    imageMimeType?: string | null;
    imageFileName?: string | null;
    mediaType?: 'image' | 'video' | null;
    mediaPayload?: Record<string, unknown> | null;
    mediaMimeType?: string | null;
    mediaFileName?: string | null;
  }): ChannelSuggestionImageAsset[] {
    return channelDialogValues.normalizeChannelSuggestionImages(params);
  }

  private readChannelDialogSuggestionReviewStatus(
    value: unknown,
  ): ChannelDialogSuggestionReviewStatus | null {
    return channelDialogValues.readChannelDialogSuggestionReviewStatus(value);
  }

  private async resolveDialogReplyPreview(params: {
    chatId: string;
    entityType: ManagedEntityType;
    dialogType: ChannelDialogType;
    threadId: string | null;
    replyToMessageId: string | null | undefined;
    dialogProfile?: MiniappProfile;
  }): Promise<ChannelDialogReplyPreview | null> {
    const replyToMessageId = this.readTrimmedString(params.replyToMessageId);
    if (!replyToMessageId) {
      return null;
    }

    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Ответ доступен только в комментариях.');
    }

    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: replyToMessageId,
        chatId: params.chatId,
        action: resolveDialogAuditAction(params.dialogType, params.dialogProfile),
        ...(params.threadId
          ? {
              payload: {
                path: ['threadId'],
                equals: params.threadId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        payload: true,
      },
    });

    if (!row) {
      throw new BadRequestException('Сообщение для ответа не найдено.');
    }

    const payload = this.readObjectPayload(row.payload);
    return {
      messageId: row.id,
      authorDisplayName: this.readTrimmedString(payload.authorDisplayName),
      text: this.buildChannelDialogReplyPreviewText(payload),
    };
  }

  private async resolveEntityDialogMessageTarget(params: {
    chatId: string;
    entityType: ManagedEntityType;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    dialogProfile?: MiniappProfile;
  }): Promise<{
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date };
    payload: Record<string, unknown>;
    threadId: string | null;
  }> {
    const threadId =
      params.entityType === 'channel'
        ? params.dialogProfile === 'publisher'
          ? this.publisherDialogProfileRuntime.resolveRequiredPublisherThreadId(
              params.chatId,
              params.entityType,
              params.dialogType,
              params.token,
            )
          : this.dialogLinkHelper.resolveChannelDialogThreadId(
              params.chatId,
              params.dialogType,
              params.token,
            )
        : params.dialogProfile === 'publisher'
          ? this.publisherDialogProfileRuntime.resolveRequiredPublisherThreadId(
              params.chatId,
              params.entityType,
              params.dialogType,
              params.token,
            )
          : this.publisherDialogProfileRuntime.resolveChatThreadId(
              params.chatId,
              params.dialogType,
              params.token,
              'moderation',
            );
    const messageId = this.readTrimmedString(params.messageId);
    if (!messageId) {
      throw new BadRequestException('Комментарий не найден.');
    }

    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: messageId,
        chatId: params.chatId,
        action: resolveDialogAuditAction(params.dialogType, params.dialogProfile),
        ...(threadId
          ? {
              payload: {
                path: ['threadId'],
                equals: threadId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        actorUserId: true,
        payload: true,
        createdAt: true,
      },
    });

    if (!row) {
      throw new BadRequestException('Комментарий не найден.');
    }

    return {
      row,
      payload: this.readObjectPayload(row.payload),
      threadId,
    };
  }

  private async updateEntityDialogMessage(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    text: string;
    dialogProfile?: MiniappProfile;
  }) {
    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Редактирование доступно только в комментариях.');
    }

    const updated = await updateDialogCommentForProfile({
      prisma: this.prisma,
      entityType: params.entityType,
      chatId: params.chatId,
      messageId: params.messageId,
      dialogProfile: params.dialogProfile,
      userId: params.userId,
      text: params.text,
      resolvePublisherThreadId: () =>
        this.publisherDialogProfileRuntime.resolveRequiredPublisherThreadId(
          params.chatId,
          params.entityType,
          params.dialogType,
          params.token,
        ),
      resolveLegacyTarget: () => this.resolveEntityDialogMessageTarget(params),
      hasAttachments: (value) => this.readChannelDialogAttachmentAssets(value).length > 0,
    });
    if (!updated) {
      throw new BadRequestException('Комментарий не найден.');
    }
    const adminUserIds =
      params.dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readAdminUserIds(
            params.chatId,
            params.entityType,
          )
        : await this.dialogAdminAccessRuntime.readRemoteOrPersisted(params.chatId);

    return updateChannelDialogMessageResponseSchema.parse({
      ok: true,
      message: this.mapChannelDialogAuditLog(
        updated,
        params.dialogType,
        params.userId,
        adminUserIds,
      ),
    });
  }

  private async deleteEntityDialogMessage(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    dialogProfile?: MiniappProfile;
  }) {
    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Удаление доступно только в комментариях.');
    }

    const target = await this.resolveEntityDialogMessageTarget(params);
    if (target.row.actorUserId !== params.userId) {
      if (params.dialogProfile === 'publisher') {
        await this.publisherDialogProfileRuntime.assertAdminAccess(
          params.chatId,
          params.userId,
          params.entityType,
        );
      } else {
        await this.assertChatAdmin(params.chatId, params.userId, params.entityType);
        await this.ensureEntityType(params.chatId, params.userId, params.entityType);
      }
    }

    await this.prisma.auditLog.delete({
      where: {
        id: target.row.id,
      },
    });

    if (target.threadId) {
      await this.syncCommentsButtonCount({
        chatId: params.chatId,
        entityType: params.entityType,
        threadId: target.threadId,
        dialogProfile: params.dialogProfile,
      });
    }

    return deleteChannelDialogMessageResponseSchema.parse({
      ok: true,
      deletedMessageId: target.row.id,
    });
  }

  private async toggleEntityDialogReaction(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    emoji: string;
    dialogProfile?: MiniappProfile;
  }) {
    if (params.dialogType !== 'comments') {
      throw new BadRequestException('Реакции доступны только в комментариях.');
    }

    const updated = await toggleDialogCommentReactionForProfile({
      prisma: this.prisma,
      entityType: params.entityType,
      chatId: params.chatId,
      messageId: params.messageId,
      dialogProfile: params.dialogProfile,
      userId: params.userId,
      emoji: params.emoji,
      resolvePublisherThreadId: () =>
        this.publisherDialogProfileRuntime.resolveRequiredPublisherThreadId(
          params.chatId,
          params.entityType,
          params.dialogType,
          params.token,
        ),
      resolveLegacyTarget: () => this.resolveEntityDialogMessageTarget(params),
      toggleReactions: (value, emoji, userId) =>
        this.toggleDialogReactionEntries(value, emoji, userId),
    });
    if (!updated) {
      throw new BadRequestException('Комментарий не найден.');
    }
    const adminUserIds =
      params.dialogProfile === 'publisher'
        ? await this.publisherDialogProfileRuntime.readAdminUserIds(
            params.chatId,
            params.entityType,
          )
        : await this.dialogAdminAccessRuntime.readRemoteOrPersisted(params.chatId);

    return toggleChannelDialogReactionResponseSchema.parse({
      ok: true,
      message: this.mapChannelDialogAuditLog(
        updated,
        params.dialogType,
        params.userId,
        adminUserIds,
      ),
    });
  }

  private async readEntityDialogNotificationSettings(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string | null;
    userId: string;
  }): Promise<ChannelDialogNotificationSettings> {
    const persistedEntityType = toPrismaEntityType(params.entityType);
    const threadId = this.normalizeDialogNotificationThreadId(params.threadId);
    const [threadRow, channelPreference, allChannelsPreference, availableChannelCount] =
      await Promise.all([
        this.prisma.dialogNotificationSubscription.findUnique({
          where: {
            entityType_chatId_threadId_userId: {
              entityType: persistedEntityType,
              chatId: params.chatId,
              threadId,
              userId: params.userId,
            },
          },
          select: {
            mode: true,
            explicit: true,
          },
        }),
        this.readDialogNotificationPreference({
          entityType: params.entityType,
          userId: params.userId,
          scope: 'channel',
          chatId: params.chatId,
        }),
        this.readDialogNotificationPreference({
          entityType: params.entityType,
          userId: params.userId,
          scope: 'all_channels',
        }),
        this.countUserGrantedManagedEntitiesForDialogNotifications({
          entityType: params.entityType,
          userId: params.userId,
        }),
      ]);

    const thread = {
      mode: threadRow ? this.fromPrismaDialogNotificationMode(threadRow.mode) : 'off',
      explicit: Boolean(threadRow?.explicit),
    };
    const channel = {
      mode: channelPreference
        ? this.fromPrismaDialogNotificationMode(channelPreference.mode)
        : 'off',
      explicit: Boolean(channelPreference),
    };
    const allChannels = {
      mode: allChannelsPreference
        ? this.fromPrismaDialogNotificationMode(allChannelsPreference.mode)
        : 'off',
      explicit: Boolean(allChannelsPreference),
    };

    return {
      mode: this.resolveEffectiveDialogNotificationMode({
        thread,
        channel,
        allChannels,
      }),
      canUseAll: true,
      scope: this.resolveActiveDialogNotificationScope({
        thread,
        channel,
        allChannels,
      }),
      thread,
      channel,
      allChannels,
      availableChannelCount,
    };
  }

  private async readDialogNotificationPreference(params: {
    entityType: ManagedEntityType;
    userId: string;
    scope: Exclude<ChannelDialogNotificationScope, 'thread'>;
    chatId?: string | null;
  }): Promise<{ mode: PrismaDialogNotificationMode } | null> {
    return this.prisma.dialogNotificationPreference.findUnique({
      where: {
        userId_entityType_scope_targetKey: {
          userId: params.userId,
          entityType: toPrismaEntityType(params.entityType),
          scope: this.toPrismaDialogNotificationScope(params.scope),
          targetKey: this.resolveDialogNotificationPreferenceTargetKey(params.scope, params.chatId),
        },
      },
      select: {
        mode: true,
      },
    });
  }

  private async upsertEntityDialogNotificationSubscription(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string | null;
    userId: string;
    mode: ChannelDialogNotificationMode;
    scope: ChannelDialogNotificationScope;
  }): Promise<ChannelDialogNotificationSettings> {
    const persistedMode = this.toPrismaDialogNotificationMode(params.mode);

    if (params.scope === 'thread') {
      await this.prisma.dialogNotificationSubscription.upsert({
        where: {
          entityType_chatId_threadId_userId: {
            entityType: toPrismaEntityType(params.entityType),
            chatId: params.chatId,
            threadId: this.normalizeDialogNotificationThreadId(params.threadId),
            userId: params.userId,
          },
        },
        create: {
          entityType: toPrismaEntityType(params.entityType),
          chatId: params.chatId,
          threadId: this.normalizeDialogNotificationThreadId(params.threadId),
          userId: params.userId,
          mode: persistedMode,
          explicit: true,
        },
        update: {
          mode: persistedMode,
          explicit: true,
        },
        select: {
          mode: true,
        },
      });
    } else {
      const targetKey = this.resolveDialogNotificationPreferenceTargetKey(
        params.scope,
        params.chatId,
      );
      await this.prisma.dialogNotificationPreference.upsert({
        where: {
          userId_entityType_scope_targetKey: {
            userId: params.userId,
            entityType: toPrismaEntityType(params.entityType),
            scope: this.toPrismaDialogNotificationScope(params.scope),
            targetKey,
          },
        },
        create: {
          userId: params.userId,
          entityType: toPrismaEntityType(params.entityType),
          scope: this.toPrismaDialogNotificationScope(params.scope),
          targetKey,
          chatId: params.scope === 'channel' ? params.chatId : null,
          mode: persistedMode,
        },
        update: {
          chatId: params.scope === 'channel' ? params.chatId : null,
          mode: persistedMode,
        },
        select: {
          mode: true,
        },
      });
    }

    return this.readEntityDialogNotificationSettings({
      entityType: params.entityType,
      chatId: params.chatId,
      threadId: params.threadId,
      userId: params.userId,
    });
  }

  private async ensureEntityDialogReplySubscription(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string | null;
    userId: string;
  }): Promise<void> {
    try {
      await this.prisma.dialogNotificationSubscription.upsert({
        where: {
          entityType_chatId_threadId_userId: {
            entityType: toPrismaEntityType(params.entityType),
            chatId: params.chatId,
            threadId: this.normalizeDialogNotificationThreadId(params.threadId),
            userId: params.userId,
          },
        },
        create: {
          entityType: toPrismaEntityType(params.entityType),
          chatId: params.chatId,
          threadId: this.normalizeDialogNotificationThreadId(params.threadId),
          userId: params.userId,
          mode: PrismaDialogNotificationMode.REPLIES,
          explicit: false,
        },
        update: {},
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          userId: params.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to ensure comment dialog reply subscription',
      );
    }
  }

  private normalizeDialogNotificationThreadId(threadId: string | null | undefined): string {
    return this.readTrimmedString(threadId) ?? '';
  }

  private resolveDialogNotificationPreferenceTargetKey(
    scope: Exclude<ChannelDialogNotificationScope, 'thread'>,
    chatId?: string | null,
  ): string {
    if (scope === 'all_channels') {
      return '*';
    }

    return this.readTrimmedString(chatId) ?? '';
  }

  private toPrismaDialogNotificationScope(
    scope: Exclude<ChannelDialogNotificationScope, 'thread'>,
  ): PrismaDialogNotificationScope {
    return scope === 'all_channels'
      ? PrismaDialogNotificationScope.ALL_CHANNELS
      : PrismaDialogNotificationScope.CHANNEL;
  }

  private toPrismaDialogNotificationMode(
    mode: ChannelDialogNotificationMode,
  ): PrismaDialogNotificationMode {
    if (mode === 'all') {
      return PrismaDialogNotificationMode.ALL;
    }
    if (mode === 'off') {
      return PrismaDialogNotificationMode.OFF;
    }
    return PrismaDialogNotificationMode.REPLIES;
  }

  private fromPrismaDialogNotificationMode(value: unknown): ChannelDialogNotificationMode {
    const normalized = this.readTrimmedString(value)?.toUpperCase();
    if (normalized === PrismaDialogNotificationMode.ALL) {
      return 'all';
    }
    if (normalized === PrismaDialogNotificationMode.OFF) {
      return 'off';
    }
    return 'replies';
  }

  private resolveActiveDialogNotificationScope(params: {
    thread: { mode: ChannelDialogNotificationMode; explicit: boolean };
    channel: { mode: ChannelDialogNotificationMode; explicit: boolean };
    allChannels: { mode: ChannelDialogNotificationMode; explicit: boolean };
  }): ChannelDialogNotificationScope {
    if (params.thread.explicit) {
      return 'thread';
    }
    if (params.channel.explicit) {
      return 'channel';
    }
    if (params.allChannels.explicit) {
      return 'all_channels';
    }
    if (params.thread.mode !== 'off') {
      return 'thread';
    }
    return 'thread';
  }

  private resolveEffectiveDialogNotificationMode(params: {
    thread: { mode: ChannelDialogNotificationMode; explicit: boolean };
    channel: { mode: ChannelDialogNotificationMode; explicit: boolean };
    allChannels: { mode: ChannelDialogNotificationMode; explicit: boolean };
  }): ChannelDialogNotificationMode {
    if (params.thread.explicit) {
      return params.thread.mode;
    }
    if (params.channel.explicit) {
      return params.channel.mode;
    }
    if (params.allChannels.explicit) {
      return params.allChannels.mode;
    }
    if (params.thread.mode !== 'off') {
      return params.thread.mode;
    }
    return 'off';
  }

  private async countUserGrantedManagedEntitiesForDialogNotifications(params: {
    entityType: ManagedEntityType;
    userId: string;
  }): Promise<number> {
    const client = this.getManagedEntityAccessEdgeClient();
    if (!client) {
      return 0;
    }

    try {
      const rows = await client.findMany({
        where: {
          userId: params.userId,
          entityType: toPrismaEntityType(params.entityType),
          state: 'GRANTED',
          OR: [
            { expiresAt: { gt: new Date() } },
            {
              expiresAt: null,
              checkedAt: { gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS) },
            },
          ],
        },
        select: {
          chatId: true,
          botId: true,
        },
      });
      const activeMembershipKeys = await this.readActiveManagedEntityMembershipKeys(rows, {
        userId: params.userId,
        requestedItems: rows.length,
        source: 'dialog_notification_available_entities',
      });
      return new Set(
        rows
          .filter((row) =>
            activeMembershipKeys.has(this.buildManagedEntityRepairEdgeKey(row.chatId, row.botId)),
          )
          .map((row) => row.chatId),
      ).size;
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType: params.entityType,
          userId: params.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to count dialog notification available entities',
      );
      return 0;
    }
  }

  private buildDialogNotificationRecipientCandidates(params: {
    subscriptions: DialogNotificationPreferenceRow[];
    channelPreferences: DialogNotificationPreferenceRow[];
    allChannelPreferences: DialogNotificationPreferenceRow[];
  }): DialogNotificationRecipientCandidate[] {
    const candidates = new Map<string, DialogNotificationRecipientCandidate>();
    const apply = (
      source: DialogNotificationRecipientCandidate['source'],
      rows: DialogNotificationPreferenceRow[],
    ) => {
      for (const row of rows) {
        const userId = this.readTrimmedString(row.userId);
        if (!userId) {
          continue;
        }
        candidates.set(userId, {
          userId,
          mode: row.mode,
          source,
        });
      }
    };

    apply('all_channels', params.allChannelPreferences);
    apply('channel', params.channelPreferences);
    apply(
      'thread',
      params.subscriptions.filter((subscription) => subscription.explicit !== false),
    );
    return Array.from(candidates.values());
  }

  private resolveEffectiveDialogNotificationCandidateForUser(params: {
    userId: string;
    subscriptions: DialogNotificationPreferenceRow[];
    channelPreferences: DialogNotificationPreferenceRow[];
    allChannelPreferences: DialogNotificationPreferenceRow[];
  }): DialogNotificationRecipientCandidate | null {
    const userId = this.readTrimmedString(params.userId);
    if (!userId) {
      return null;
    }

    const explicitSubscriptions = params.subscriptions.filter(
      (subscription) => subscription.explicit !== false,
    );
    const implicitSubscriptions = params.subscriptions.filter(
      (subscription) => subscription.explicit === false,
    );
    const sources: Array<{
      source: DialogNotificationRecipientCandidate['source'];
      rows: DialogNotificationPreferenceRow[];
    }> = [
      { source: 'thread', rows: explicitSubscriptions },
      { source: 'channel', rows: params.channelPreferences },
      { source: 'all_channels', rows: params.allChannelPreferences },
      { source: 'thread', rows: implicitSubscriptions },
    ];

    for (const { source, rows } of sources) {
      const row = rows.find((item) => this.readTrimmedString(item.userId) === userId);
      if (row) {
        return {
          userId,
          mode: row.mode,
          source,
        };
      }
    }

    return null;
  }

  private async filterDialogNotificationUsersByEntityAccess(params: {
    entityType: ManagedEntityType;
    chatId: string;
    userIds: string[];
  }): Promise<Set<string>> {
    const normalizedUserIds = Array.from(
      new Set(
        params.userIds
          .map((userId) => this.readTrimmedString(userId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return new Set();
    }

    const client = this.getManagedEntityAccessEdgeClient();
    if (!client) {
      return new Set();
    }

    try {
      const rows = await client.findMany({
        where: {
          chatId: params.chatId,
          entityType: toPrismaEntityType(params.entityType),
          userId: {
            in: normalizedUserIds,
          },
          state: 'GRANTED',
          OR: [
            { expiresAt: { gt: new Date() } },
            {
              expiresAt: null,
              checkedAt: { gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS) },
            },
          ],
        },
        select: {
          chatId: true,
          userId: true,
          botId: true,
        },
      });
      const activeMembershipKeys = await this.readActiveManagedEntityMembershipKeys(rows, {
        userId: normalizedUserIds.join(','),
        requestedItems: normalizedUserIds.length,
        source: 'dialog_notification_delivery',
      });
      return new Set(
        rows
          .filter((row) =>
            activeMembershipKeys.has(this.buildManagedEntityRepairEdgeKey(row.chatId, row.botId)),
          )
          .map((row) => this.readTrimmedString(row.userId))
          .filter((userId): userId is string => Boolean(userId)),
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityType: params.entityType,
          chatId: params.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to filter dialog notification recipients by access edge',
      );
      return new Set();
    }
  }

  private async deliverEntityDialogCommentNotifications(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string | null;
    messageId: string;
    authorUserId: string;
    authorDisplayName: string | null;
    text: string;
    attachmentCount: number;
    replyToMessageId: string | null;
  }): Promise<void> {
    const authorUserId = this.readTrimmedString(params.authorUserId);
    if (!authorUserId) {
      return;
    }

    const persistedEntityType = toPrismaEntityType(params.entityType);
    const threadId = this.normalizeDialogNotificationThreadId(params.threadId);
    const replyTargetUserId = await this.resolveCommentDialogReplyTargetUserId({
      chatId: params.chatId,
      threadId: params.threadId,
      replyToMessageId: params.replyToMessageId,
    });
    const normalizedReplyTargetUserId = this.readTrimmedString(replyTargetUserId);
    const [subscriptions, channelPreferences, allChannelPreferences] = await Promise.all([
      this.prisma.dialogNotificationSubscription.findMany({
        where: {
          chatId: params.chatId,
          entityType: persistedEntityType,
          threadId,
        },
        select: {
          userId: true,
          mode: true,
          explicit: true,
        },
      }),
      this.prisma.dialogNotificationPreference.findMany({
        where: {
          entityType: persistedEntityType,
          scope: PrismaDialogNotificationScope.CHANNEL,
          targetKey: params.chatId,
        },
        select: {
          userId: true,
          mode: true,
        },
      }),
      this.prisma.dialogNotificationPreference.findMany({
        where: {
          entityType: persistedEntityType,
          scope: PrismaDialogNotificationScope.ALL_CHANNELS,
          targetKey: '*',
          ...(normalizedReplyTargetUserId
            ? {
                OR: [
                  { mode: PrismaDialogNotificationMode.ALL },
                  { userId: normalizedReplyTargetUserId },
                ],
              }
            : {
                mode: PrismaDialogNotificationMode.ALL,
              }),
        },
        select: {
          userId: true,
          mode: true,
        },
      }),
    ]);

    const recipients = new Map<string, CommentDialogNotificationKind>();
    const candidateRows = this.buildDialogNotificationRecipientCandidates({
      subscriptions,
      channelPreferences,
      allChannelPreferences,
    });
    const globallyScopedUserIds = candidateRows
      .filter(
        (candidate) =>
          candidate.source === 'all_channels' &&
          (candidate.mode === PrismaDialogNotificationMode.ALL ||
            (candidate.mode === PrismaDialogNotificationMode.REPLIES &&
              candidate.userId === normalizedReplyTargetUserId)),
      )
      .map((candidate) => candidate.userId);
    const globalUserIdsWithAccess = await this.filterDialogNotificationUsersByEntityAccess({
      entityType: params.entityType,
      chatId: params.chatId,
      userIds: globallyScopedUserIds,
    });
    if (normalizedReplyTargetUserId && normalizedReplyTargetUserId !== authorUserId) {
      const targetCandidate = this.resolveEffectiveDialogNotificationCandidateForUser({
        userId: normalizedReplyTargetUserId,
        subscriptions,
        channelPreferences,
        allChannelPreferences,
      });
      if (
        targetCandidate &&
        (targetCandidate.mode === PrismaDialogNotificationMode.REPLIES ||
          targetCandidate.mode === PrismaDialogNotificationMode.ALL) &&
        (targetCandidate.source !== 'all_channels' ||
          globalUserIdsWithAccess.has(normalizedReplyTargetUserId))
      ) {
        recipients.set(normalizedReplyTargetUserId, 'reply');
      }
    }

    for (const candidate of candidateRows) {
      const userId = this.readTrimmedString(candidate.userId);
      if (
        !userId ||
        userId === authorUserId ||
        recipients.has(userId) ||
        candidate.mode !== PrismaDialogNotificationMode.ALL ||
        (candidate.source === 'all_channels' && !globalUserIdsWithAccess.has(userId))
      ) {
        continue;
      }
      recipients.set(userId, 'all');
    }

    if (recipients.size === 0) {
      return;
    }

    const routeBotId = await this.resolveBotAssignment(params.chatId);
    const deliveryBotId = this.resolvePrivateDeliveryBotId(routeBotId);
    const dialogUrl = this.buildEntityDialogNotificationUrl({
      entityType: params.entityType,
      chatId: params.chatId,
      threadId,
      botId: deliveryBotId,
    });
    if (!dialogUrl) {
      this.logger.warn(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          threadId,
        },
        'Skipping comment dialog notifications without dialog url',
      );
      return;
    }

    const entityTarget = await this.resolveDialogNotificationEntityTarget({
      entityType: params.entityType,
      chatId: params.chatId,
      botId: deliveryBotId,
    });
    let postUrl: string | null = null;
    let postPreview: string | null = null;
    try {
      const postContext = await this.resolveDialogNotificationPostContext({
        entityType: params.entityType,
        chatId: params.chatId,
        threadId,
        botId: deliveryBotId,
      });
      postUrl = postContext.url;
      postPreview = postContext.preview;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          threadId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve comment notification post url',
      );
    }
    const preview = this.buildCommentDialogNotificationPreview(params.text, params.attachmentCount);
    const buttons: MaxMessageButton[][] = [
      [
        {
          type: 'link',
          text: 'Открыть комментарии',
          url: dialogUrl,
        },
      ],
    ];
    if (postUrl) {
      buttons.push([
        {
          type: 'link',
          text: 'Открыть пост',
          url: postUrl,
        },
      ]);
    }
    const recipientEntries = Array.from(recipients.entries()).map(([userId, kind]) => ({
      userId,
      kind,
    }));

    await mapWithConcurrencyLimit(
      recipientEntries,
      COMMENT_NOTIFICATION_DELIVERY_CONCURRENCY,
      async (recipient) => {
        try {
          await this.maxClient.sendMessageImmediateToUser(
            recipient.userId,
            this.buildCommentDialogNotificationText({
              kind: recipient.kind,
              entityType: params.entityType,
              entityTitle: entityTarget.title,
              entityLink: entityTarget.link,
              authorUserId,
              authorDisplayName: params.authorDisplayName,
              preview,
              postPreview,
              dialogUrl,
              postUrl,
            }),
            {
              buttons,
              textFormat: 'html',
            },
            {
              trafficClass: 'background',
              sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
              ...(deliveryBotId ? { botId: deliveryBotId } : {}),
            },
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: params.chatId,
              entityType: params.entityType,
              messageId: params.messageId,
              recipientUserId: recipient.userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to deliver comment dialog notification',
          );
        }
      },
    );
  }

  private async resolveCommentDialogReplyTargetUserId(params: {
    chatId: string;
    threadId: string | null;
    replyToMessageId: string | null;
  }): Promise<string | null> {
    const replyToMessageId = this.readTrimmedString(params.replyToMessageId);
    if (!replyToMessageId) {
      return null;
    }

    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: replyToMessageId,
        chatId: params.chatId,
        action: CHANNEL_DIALOG_ACTION_COMMENT,
        ...(params.threadId
          ? {
              payload: {
                path: ['threadId'],
                equals: params.threadId,
              },
            }
          : {}),
      },
      select: {
        actorUserId: true,
      },
    });

    return this.readTrimmedString(row?.actorUserId);
  }

  private async resolveDialogNotificationPostContext(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string;
    botId?: string | null;
  }): Promise<{ url: string | null; preview: string | null }> {
    const actions =
      params.entityType === 'channel'
        ? [CHANNEL_DIALOG_ACTION_PUBLISH, CHANNEL_DIALOG_ACTION_AUTO_ATTACH]
        : [CHAT_DIALOG_ACTION_AUTO_ATTACH];

    const rows = await this.prisma.auditLog.findMany({
      where: {
        chatId: params.chatId,
        action: {
          in: actions,
        },
        payload: {
          path: ['threadId'],
          equals: params.threadId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 5,
      select: {
        action: true,
        payload: true,
      },
    });

    let preview: string | null = null;
    for (const row of rows) {
      const payload = this.readObjectPayload(row.payload);
      preview ??= this.buildCommentDialogPostPreview(this.readRawString(payload.text));
      if (preview) {
        break;
      }
    }

    for (const row of rows) {
      const payload = this.readObjectPayload(row.payload);
      const persistedUrl = this.normalizeMaxEntityLink(
        this.readTrimmedString(payload.publishedUrl),
      );
      if (persistedUrl) {
        if (!preview) {
          const messageId = this.resolveDialogNotificationPostPreviewMessageId(row.action, payload);
          preview = messageId
            ? await this.resolveDialogNotificationPostMessagePreview(messageId, params.botId)
            : null;
        }
        return { url: persistedUrl, preview };
      }
    }

    let fallbackPostContext: {
      action: string;
      payload: Record<string, unknown>;
      url: string;
    } | null = null;
    for (const row of rows) {
      const payload = this.readObjectPayload(row.payload);
      const messageIds = this.resolveDialogNotificationPostMessageIds(row.action, payload);
      for (const messageId of messageIds) {
        const fallbackUrl = this.buildMaxMessageFallbackUrl(params.chatId, messageId);
        if (!fallbackPostContext && fallbackUrl) {
          fallbackPostContext = {
            action: row.action,
            payload,
            url: fallbackUrl,
          };
        }
        const resolvedUrl = await this.resolveDialogNotificationMessageUrl(messageId, params.botId);
        if (resolvedUrl) {
          if (!preview) {
            const previewMessageId = this.resolveDialogNotificationPostPreviewMessageId(
              row.action,
              payload,
            );
            preview = previewMessageId
              ? await this.resolveDialogNotificationPostMessagePreview(
                  previewMessageId,
                  params.botId,
                )
              : null;
          }
          return { url: resolvedUrl, preview };
        }
      }
    }

    if (fallbackPostContext) {
      if (!preview) {
        const previewMessageId = this.resolveDialogNotificationPostPreviewMessageId(
          fallbackPostContext.action,
          fallbackPostContext.payload,
        );
        preview = previewMessageId
          ? await this.resolveDialogNotificationPostMessagePreview(previewMessageId, params.botId)
          : null;
      }
      return { url: fallbackPostContext.url, preview };
    }

    return { url: null, preview };
  }

  private buildMaxMessageFallbackUrl(chatId: string, messageId: string | null): string | null {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId?.trim() ?? '';
    if (!normalizedChatId || !normalizedMessageId) {
      return null;
    }

    return `https://max.ru/chats/${encodeURIComponent(normalizedChatId)}/message/${encodeURIComponent(
      normalizedMessageId,
    )}`;
  }

  private resolveDialogNotificationPostMessageIds(
    action: string,
    payload: Record<string, unknown>,
  ): string[] {
    const candidates: Array<string | null> = [];
    if (action === CHANNEL_DIALOG_ACTION_PUBLISH) {
      candidates.push(this.readTrimmedString(payload.messageId));
      return this.uniqueDialogNotificationMessageIds(candidates);
    }

    const deliveryMode = this.readTrimmedString(payload.deliveryMode);
    if (deliveryMode === 'replace_with_bot_message') {
      candidates.push(
        this.readTrimmedString(payload.replacementMessageId),
        this.readTrimmedString(payload.messageId),
      );
      return this.uniqueDialogNotificationMessageIds(candidates);
    }

    if (deliveryMode === 'reply_message') {
      candidates.push(
        this.readTrimmedString(payload.messageId),
        this.readTrimmedString(payload.replyMessageId),
      );
      return this.uniqueDialogNotificationMessageIds(candidates);
    }

    candidates.push(this.readTrimmedString(payload.messageId));
    return this.uniqueDialogNotificationMessageIds(candidates);
  }

  private resolveDialogNotificationPostPreviewMessageId(
    action: string,
    payload: Record<string, unknown>,
  ): string | null {
    if (action === CHANNEL_DIALOG_ACTION_PUBLISH) {
      return this.readTrimmedString(payload.messageId);
    }

    const deliveryMode = this.readTrimmedString(payload.deliveryMode);
    if (deliveryMode === 'replace_with_bot_message') {
      return this.readTrimmedString(payload.replacementMessageId);
    }

    return this.readTrimmedString(payload.messageId);
  }

  private uniqueDialogNotificationMessageIds(candidates: Array<string | null>): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      const messageId = this.readTrimmedString(candidate);
      if (!messageId || seen.has(messageId)) {
        continue;
      }
      seen.add(messageId);
      ids.push(messageId);
    }

    return ids;
  }

  private async resolveDialogNotificationMessageUrl(
    messageId: string,
    botId?: string | null,
  ): Promise<string | null> {
    const maxClient = this.maxClient as MaxClientService & {
      resolveMessageLink?: MaxClientService['resolveMessageLink'];
    };
    if (typeof maxClient.resolveMessageLink !== 'function') {
      return null;
    }

    try {
      return this.normalizeMaxEntityLink(
        await maxClient.resolveMessageLink(messageId, {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          ...(botId ? { botId } : {}),
        }),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve comment notification post link',
      );
      return null;
    }
  }

  private async resolveDialogNotificationPostMessagePreview(
    messageId: string,
    botId?: string | null,
  ): Promise<string | null> {
    const maxClient = this.maxClient as MaxClientService & {
      getMessageTextAsMarkdown?: MaxClientService['getMessageTextAsMarkdown'];
    };
    if (typeof maxClient.getMessageTextAsMarkdown !== 'function') {
      return null;
    }

    try {
      return this.buildCommentDialogPostPreview(
        await maxClient.getMessageTextAsMarkdown(messageId, {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          ...(botId ? { botId } : {}),
        }),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve comment notification post preview',
      );
      return null;
    }
  }

  private buildEntityDialogNotificationUrl(params: {
    entityType: ManagedEntityType;
    chatId: string;
    threadId: string;
    botId?: string | null;
  }): string | null {
    if (params.entityType === 'channel') {
      return (
        this.dialogLinkHelper.buildChannelDialogLaunchUrl(
          params.chatId,
          'comments',
          params.threadId,
          params.botId,
        ) ??
        this.dialogLinkHelper.buildChannelDialogDirectWebAppUrl(
          params.chatId,
          'comments',
          params.threadId,
        )
      );
    }

    return (
      this.dialogLinkHelper.buildChatDialogLaunchUrl(
        params.chatId,
        'comments',
        params.threadId,
        params.botId,
      ) ??
      this.dialogLinkHelper.buildChatDialogDirectWebAppUrl(
        params.chatId,
        'comments',
        params.threadId,
      )
    );
  }

  private async resolveDialogNotificationEntityTarget(params: {
    entityType: ManagedEntityType;
    chatId: string;
    botId?: string | null;
  }): Promise<{ title: string; link: string | null }> {
    const local = await this.prisma.chat.findUnique({
      where: { id: params.chatId },
      select: { title: true },
    });

    let title = resolvePresentableManagedEntityTitle(params.chatId, local?.title);
    let link: string | null = null;

    try {
      const cachedHeader = await this.chatContextCache.getManagedEntityHeader?.(
        params.chatId,
        params.entityType,
      );
      title ??= resolvePresentableManagedEntityTitle(params.chatId, cachedHeader?.title);
      link = this.normalizeMaxEntityLink(cachedHeader?.link) ?? link;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          entityType: params.entityType,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve cached comment notification entity link',
      );
    }

    if (!link) {
      try {
        const catalogRows = await this.prisma.managedBotChatCatalog.findMany({
          where: {
            chatId: params.chatId,
            status: 'ACTIVE',
          },
          orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
          take: 5,
          select: {
            title: true,
            link: true,
          },
        });

        for (const row of catalogRows) {
          title ??= resolvePresentableManagedEntityTitle(params.chatId, row.title);
          link = this.normalizeMaxEntityLink(row.link) ?? link;
          if (title && link) {
            break;
          }
        }
      } catch (error: unknown) {
        this.logger.debug(
          {
            chatId: params.chatId,
            entityType: params.entityType,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve catalog comment notification entity link',
        );
      }
    }

    if (!title || !link) {
      try {
        const remoteSnapshot = await this.maxClient.getChatSnapshot(params.chatId, {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          ...(params.botId ? { botId: params.botId } : {}),
        });
        title ??= resolvePresentableManagedEntityTitle(params.chatId, remoteSnapshot.title);
        link = this.normalizeMaxEntityLink(remoteSnapshot.link) ?? link;
      } catch (error: unknown) {
        this.logger.debug(
          {
            chatId: params.chatId,
            entityType: params.entityType,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve comment notification entity target',
        );
      }
    }

    return {
      title: title ?? `${params.entityType === 'channel' ? 'Канал' : 'Чат'} ${params.chatId}`,
      link,
    };
  }

  private normalizeMaxEntityLink(value: string | null | undefined): string | null {
    const normalized = this.readTrimmedString(value);
    if (!normalized) {
      return null;
    }

    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
        return null;
      }

      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private buildCommentDialogNotificationPreview(text: string, attachmentCount: number): string {
    const normalizedText = text.replace(/\s+/gu, ' ').trim();
    if (normalizedText) {
      const symbols = Array.from(normalizedText);
      if (symbols.length <= COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH) {
        return normalizedText;
      }
      return `${symbols
        .slice(0, COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
    }

    if (attachmentCount > 0) {
      return attachmentCount === 1 ? 'Вложение' : `Вложения: ${attachmentCount}`;
    }

    return 'Комментарий без текста';
  }

  private buildCommentDialogPostPreview(text: string | null): string | null {
    if (typeof text !== 'string') {
      return null;
    }

    for (const line of text.split(/\r\n|\r|\n/u)) {
      const normalizedLine = line.replace(/\s+/gu, ' ').trim();
      if (!normalizedLine) {
        continue;
      }

      const symbols = Array.from(normalizedLine);
      if (symbols.length <= COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH) {
        return normalizedLine;
      }
      return `${symbols
        .slice(0, COMMENT_NOTIFICATION_PREVIEW_MAX_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
    }

    return null;
  }

  private buildCommentDialogNotificationText(params: {
    kind: CommentDialogNotificationKind;
    entityType: ManagedEntityType;
    entityTitle: string;
    entityLink: string | null;
    authorUserId: string;
    authorDisplayName: string | null;
    preview: string;
    postPreview: string | null;
    dialogUrl: string;
    postUrl: string | null;
  }): string {
    const authorName =
      this.readTrimmedString(params.authorDisplayName) ??
      this.readTrimmedString(params.authorUserId) ??
      'Пользователь';
    const authorLink = this.readTrimmedString(params.authorUserId)
      ? `<a href="max://user/${encodeURIComponent(params.authorUserId)}">${escapeHtml(
          authorName,
        )}</a>`
      : escapeHtml(authorName);
    const entityLabel = params.entityType === 'channel' ? 'Канал' : 'Чат';
    const entityTitle = escapeHtml(params.entityTitle);
    const entityTarget = params.entityLink
      ? `<a href="${escapeHtmlAttribute(params.entityLink)}">${entityTitle}</a>`
      : entityTitle;
    const title =
      params.kind === 'reply' ? 'Вам ответили в комментариях' : 'Новый комментарий в обсуждении';
    const postLine = params.postPreview
      ? `Пост: ${escapeHtml(params.postPreview)}`
      : params.postUrl
        ? `Пост: <a href="${escapeHtmlAttribute(params.postUrl)}">Открыть пост</a>`
        : null;

    return [
      `<strong>${escapeHtml(title)}</strong>`,
      `${entityLabel}: ${entityTarget}`,
      ...(postLine ? [postLine] : []),
      `${params.kind === 'reply' ? 'Ответил' : 'Автор'}: ${authorLink}`,
      `Комментарий: ${escapeHtml(params.preview)}`,
    ].join('\n');
  }

  private channelCommentContainsLink(value: string): boolean {
    CHANNEL_COMMENT_LINK_PATTERN.lastIndex = 0;
    return CHANNEL_COMMENT_LINK_PATTERN.test(value);
  }

  private readDialogAdminUserIds(chatId: string): Promise<Set<string>> {
    return this.dialogAdminAccessRuntime.readRemoteOrPersisted(chatId);
  }

  private normalizeChannelCommentText(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/gu, ' ');
  }

  private readDialogReplyPreview(value: unknown): ChannelDialogReplyPreview | null {
    return channelDialogValues.readDialogReplyPreview(value);
  }

  private readDialogReactionGroups(
    value: unknown,
    currentUserId?: string | null,
  ): ChannelDialogReactionGroup[] {
    return channelDialogValues.readDialogReactionGroups(value, currentUserId);
  }

  private readDialogReactionEntries(value: unknown): Array<{ emoji: string; userIds: string[] }> {
    return channelDialogValues.readDialogReactionEntries(value);
  }

  private toggleDialogReactionEntries(
    currentValue: unknown,
    emojiRaw: string,
    userIdRaw: string,
  ): Array<{ emoji: string; userIds: string[] }> {
    const emoji = this.readTrimmedString(emojiRaw);
    const userId = this.readTrimmedString(userIdRaw);
    if (!emoji || !userId) {
      throw new BadRequestException('Реакцию не удалось обработать.');
    }

    const entries = this.readDialogReactionEntries(currentValue).map((entry) => ({
      emoji: entry.emoji,
      userIds: [...entry.userIds],
    }));
    const reactedEmoji = entries.find((entry) => entry.userIds.includes(userId))?.emoji ?? null;
    const clearedEntries = entries
      .map((entry) => ({
        emoji: entry.emoji,
        userIds: entry.userIds.filter((entryUserId) => entryUserId !== userId),
      }))
      .filter((entry) => entry.userIds.length > 0);

    if (reactedEmoji !== emoji) {
      const targetEntry = clearedEntries.find((entry) => entry.emoji === emoji);
      if (targetEntry) {
        targetEntry.userIds = Array.from(new Set([...targetEntry.userIds, userId]));
      } else {
        clearedEntries.push({
          emoji,
          userIds: [userId],
        });
      }
    }

    return clearedEntries.sort(
      (left, right) =>
        right.userIds.length - left.userIds.length || left.emoji.localeCompare(right.emoji),
    );
  }

  private readObjectPayload(value: Prisma.JsonValue): Record<string, unknown> {
    return channelDialogValues.readObjectPayload(value);
  }

  private readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
    return readObjectPayloadOrNull(value);
  }

  private readTrimmedString(value: unknown): string | null {
    return channelDialogValues.readTrimmedString(value);
  }

  private readRawString(value: unknown): string | null {
    return channelDialogValues.readRawString(value);
  }

  private readLowerString(value: unknown): string | null {
    return channelDialogValues.readLowerString(value);
  }

  private async syncCommentsButtonCount(params: {
    chatId: string;
    entityType: ManagedEntityType;
    threadId: string;
    dialogProfile?: MiniappProfile;
  }): Promise<void> {
    const { chatId, entityType, threadId } = params;

    try {
      const count =
        params.dialogProfile === 'publisher'
          ? await countPublisherChatComments(this.prisma, chatId, threadId)
          : await this.prisma.auditLog.count({
              where: {
                chatId,
                action: resolveDialogAuditAction('comments', params.dialogProfile),
                payload: {
                  path: ['threadId'],
                  equals: threadId,
                },
              },
            });

      if (entityType === 'channel') {
        await this.syncChannelCommentsButtonCount(chatId, threadId, count, params.dialogProfile);
        return;
      }

      await this.syncChatCommentsButtonCount(chatId, threadId, count, params.dialogProfile);
    } catch (error) {
      this.logger.warn(
        {
          chatId,
          entityType,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to sync comments button count',
      );
    }
  }

  private async syncChannelCommentsButtonCount(
    chatId: string,
    threadId: string,
    count: number,
    dialogProfile: MiniappProfile = 'moderation',
  ): Promise<void> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        chatId,
        action: {
          in: [CHANNEL_DIALOG_ACTION_PUBLISH, CHANNEL_DIALOG_ACTION_AUTO_ATTACH],
        },
        payload: {
          path: ['threadId'],
          equals: threadId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        action: true,
        payload: true,
      },
    });

    for (const row of rows) {
      const payload = this.readObjectPayload(row.payload);
      const botId = this.readTrimmedString(payload.botId);
      const publisherBotId = this.maxBotRegistry?.getPublisherBotDescriptor().id ?? null;
      const publisherOrigin = Boolean(publisherBotId && botId === publisherBotId);
      if ((dialogProfile === 'publisher') !== publisherOrigin) {
        continue;
      }
      if (row.action === CHANNEL_DIALOG_ACTION_PUBLISH) {
        const messageId = this.readTrimmedString(payload.messageId);
        const dialogBotId = this.readTrimmedString(payload.dialogBotId) ?? botId;
        const includeCommentsButton = payload.includeCommentsButton !== false;
        const includeSuggestButton = payload.includeSuggestButton === true;
        const suggestionEntryMode = this.readChannelSuggestionEntryMode(
          payload.suggestionEntryMode,
        );
        if (!messageId || (!includeCommentsButton && !includeSuggestButton)) {
          continue;
        }

        const storedKeyboard = prepareStoredChannelCommentsKeyboard(payload, count);
        if (storedKeyboard) {
          if (
            await this.publisherCommentKeyboardRouting.tryEnqueue({
              chatId,
              messageId,
              threadId,
              entityType: 'channel',
              botId,
              dialogBotId,
              buttons: storedKeyboard.buttons,
              commentsButton: storedKeyboard.commentsButton,
              count,
            })
          ) {
            continue;
          }
          await this.safeUpdateCommentsButton(
            chatId,
            messageId,
            storedKeyboard.buttons,
            'channel',
            botId,
            threadId,
            storedKeyboard.commentsButton,
          );
          continue;
        }

        const customButtonRows = this.buildBroadcastLinkButtonRows(
          this.normalizeManagedBroadcastButtons(payload.customButtons),
          { buttonsPerRow: 1 },
        );
        const ctaButton = await this.channelPostSignatureService?.buildPostButton(chatId, {
          entityType: 'channel',
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
        });
        const keyboard = buildChannelCommentCountKeyboard({
          includeCommentsButton,
          includeSuggestButton,
          commentsButtonText: this.readTrimmedString(payload.commentsButtonText),
          suggestButtonText:
            this.readTrimmedString(payload.suggestButtonText) || '📰 Предложить пост',
          suggestionEntryMode,
          count,
          ctaButton,
          customButtonRows,
          buildDialogButton: (type, text, entryMode) =>
            (publisherOrigin
              ? this.publisherDialogLinkService?.buildChannelDialogButton(
                  chatId,
                  type,
                  threadId,
                  text,
                  type === 'suggest' ? entryMode : 'MINIAPP',
                )
              : this.buildChannelDialogButton(
                  chatId,
                  type,
                  threadId,
                  text,
                  dialogBotId,
                  entryMode,
                )) ?? null,
        });
        if (!keyboard) continue;
        const { buttons, commentsButton: commentsButtonPosition } = keyboard;

        if (
          await this.publisherCommentKeyboardRouting.tryEnqueue({
            chatId,
            messageId,
            threadId,
            entityType: 'channel',
            botId,
            dialogBotId,
            buttons,
            commentsButton: commentsButtonPosition,
            count,
          })
        ) {
          continue;
        }
        await this.safeUpdateCommentsButton(
          chatId,
          messageId,
          buttons,
          'channel',
          botId,
          threadId,
          commentsButtonPosition,
        );
        continue;
      }

      if (row.action !== CHANNEL_DIALOG_ACTION_AUTO_ATTACH) {
        continue;
      }

      const messageId = resolveDialogCommentsTargetMessageId(payload);
      const dialogBotId = this.readTrimmedString(payload.dialogBotId) ?? botId;
      const includeCommentsButton = payload.includeCommentsButton !== false;
      const includeSuggestButton = payload.includeSuggestButton === true;
      const suggestionEntryMode = this.readChannelSuggestionEntryMode(payload.suggestionEntryMode);
      if (!messageId || (!includeCommentsButton && !includeSuggestButton)) {
        continue;
      }

      const storedKeyboard = prepareStoredChannelCommentsKeyboard(payload, count);
      if (storedKeyboard) {
        if (
          await this.publisherCommentKeyboardRouting.tryEnqueue({
            chatId,
            messageId,
            threadId,
            entityType: 'channel',
            botId,
            dialogBotId,
            buttons: storedKeyboard.buttons,
            commentsButton: storedKeyboard.commentsButton,
            count,
          })
        ) {
          continue;
        }
        await this.safeUpdateCommentsButton(
          chatId,
          messageId,
          storedKeyboard.buttons,
          'channel',
          botId,
          threadId,
          storedKeyboard.commentsButton,
        );
        continue;
      }

      const customButtonRows = this.buildBroadcastLinkButtonRows(
        this.normalizeManagedBroadcastButtons(payload.customButtons),
        { buttonsPerRow: 1 },
      );
      const ctaButton = await this.channelPostSignatureService?.buildPostButton(chatId, {
        entityType: 'channel',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
      });
      const keyboard = buildChannelCommentCountKeyboard({
        includeCommentsButton,
        includeSuggestButton,
        commentsButtonText: '💬 Комментарии',
        suggestButtonText:
          this.readTrimmedString(payload.suggestButtonText) || '📰 Предложить пост',
        suggestionEntryMode,
        count,
        ctaButton,
        customButtonRows,
        buildDialogButton: (type, text, entryMode) =>
          (publisherOrigin
            ? this.publisherDialogLinkService?.buildChannelDialogButton(
                chatId,
                type,
                threadId,
                text,
                type === 'suggest' ? entryMode : 'MINIAPP',
              )
            : this.buildChannelDialogButton(
                chatId,
                type,
                threadId,
                text,
                dialogBotId,
                entryMode,
              )) ?? null,
      });
      if (!keyboard) continue;
      const { buttons, commentsButton: commentsButtonPosition } = keyboard;

      if (
        await this.publisherCommentKeyboardRouting.tryEnqueue({
          chatId,
          messageId,
          threadId,
          entityType: 'channel',
          botId,
          dialogBotId,
          buttons,
          commentsButton: commentsButtonPosition,
          count,
        })
      ) {
        continue;
      }
      await this.safeUpdateCommentsButton(
        chatId,
        messageId,
        buttons,
        'channel',
        botId,
        threadId,
        commentsButtonPosition,
      );
    }
  }

  private async syncChatCommentsButtonCount(
    chatId: string,
    threadId: string,
    count: number,
    dialogProfile: MiniappProfile = 'moderation',
  ): Promise<void> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        chatId,
        action: CHAT_DIALOG_ACTION_AUTO_ATTACH,
        payload: {
          path: ['threadId'],
          equals: threadId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        action: true,
        payload: true,
      },
    });

    for (const row of rows) {
      if (row.action !== CHAT_DIALOG_ACTION_AUTO_ATTACH) {
        continue;
      }

      const payload = this.readObjectPayload(row.payload);
      const publisherOrigin = isPublisherChatAutoAttachPayload(payload);
      if ((dialogProfile === 'publisher') !== publisherOrigin) {
        continue;
      }
      const messageId = resolveDialogCommentsTargetMessageId(payload);
      const botId = this.readTrimmedString(payload.botId);
      const dialogBotId = this.readTrimmedString(payload.dialogBotId) ?? botId;
      const publisherBotId = this.readTrimmedString(payload.publisherBotId);
      if (!messageId) {
        continue;
      }
      if (publisherOrigin && (!publisherBotId || botId !== publisherBotId)) {
        this.logger.warn(
          { chatId, threadId, messageId },
          'Skipped Publisher comments counter because its origin attribution is invalid',
        );
        continue;
      }

      const buttons = this.buildBroadcastLinkButtonRows(
        this.normalizeManagedBroadcastButtons(payload.customButtons),
      );
      const commentsButtonPosition = createCommentsButtonPosition(buttons, '💬 Комментарии');
      const commentsButton =
        publisherOrigin && dialogBotId === publisherBotId
          ? this.publisherDialogLinkService?.buildChatDialogButton(
              chatId,
              'comments',
              threadId,
              formatCommentsButtonText('💬 Комментарии', count),
            )
          : this.dialogLinkHelper.buildChatDialogButton(
              chatId,
              'comments',
              threadId,
              formatCommentsButtonText('💬 Комментарии', count),
              dialogBotId,
            );
      if (!commentsButton) {
        this.logger.warn(
          { chatId, threadId, messageId },
          'Skipped Publisher comments counter because its signing service is unavailable',
        );
        continue;
      }
      buttons.push([commentsButton]);

      if (
        await this.publisherCommentKeyboardRouting.tryEnqueue({
          chatId,
          messageId,
          threadId,
          entityType: 'chat',
          botId,
          dialogBotId,
          buttons,
          commentsButton: commentsButtonPosition,
          count,
        })
      ) {
        continue;
      }
      await this.safeUpdateCommentsButton(
        chatId,
        messageId,
        buttons,
        'chat',
        botId,
        threadId,
        commentsButtonPosition,
      );
    }
  }

  private async safeUpdateCommentsButton(
    chatId: string,
    messageId: string,
    buttons: MaxMessageButton[][],
    entityType: ManagedEntityType,
    botId: string | null,
    threadId: string,
    commentsButton: { rowIndex: number; columnIndex: number; baseText: string | null } | null,
  ): Promise<void> {
    return refreshCommentsButtonCount(
      {
        prisma: this.prisma,
        maxClient: this.maxClient,
        logger: this.logger,
        resolveBotId: async () =>
          this.maxBotRegistry?.getBotById(botId)?.id ??
          this.readTrimmedString(botId) ??
          this.resolveDeliveryBotAssignment(chatId),
      },
      { chatId, messageId, threadId, entityType, buttons, commentsButton },
    );
  }

  private async createChannelSuggestionAuditLog(params: {
    chatId: string;
    user: AuthUser;
    threadId: string | null;
    source: ChannelDialogMessageSource;
    text: string;
    textFormat?: BroadcastTextFormat | null;
    textMarkup?: ChannelSuggestionTextMarkup[] | null;
    images?: ChannelSuggestionImageAsset[] | null;
    video?: ChannelSuggestionVideoInput;
    imageBase64?: string | null;
    imageMimeType?: string | null;
    imageFileName?: string | null;
    mediaType?: 'image' | 'video' | null;
    mediaPayload?: Record<string, unknown> | null;
    mediaMimeType?: string | null;
    mediaFileName?: string | null;
    mediaBotId?: string | null;
  }): Promise<{
    row: { id: string; actorUserId: string; payload: Prisma.JsonValue; createdAt: Date };
    delivered: boolean;
    deliveredToUserId: string | null;
    queued: boolean;
  }> {
    await this.suggestionSubscriptions?.assertCanSubmit(
      params.chatId,
      params.user.userId,
      'moderation',
    );
    const normalizedImages = this.normalizeChannelSuggestionImages({
      images: params.images,
      imageBase64: params.imageBase64,
      imageMimeType: params.imageMimeType,
      imageFileName: params.imageFileName,
      mediaType: params.mediaType,
      mediaPayload: params.mediaPayload,
      mediaMimeType: params.mediaMimeType,
      mediaFileName: params.mediaFileName,
    });
    const imageFileNames = normalizedImages
      .map((image) => image.fileName?.trim() ?? '')
      .filter((fileName): fileName is string => fileName.length > 0);
    const storeImageRows =
      normalizedImages.length > 0 &&
      params.mediaType !== 'video' &&
      normalizedImages.every(
        (image) => image.type !== 'video' && !image.mimeType?.startsWith('video/'),
      );
    const mediaRows = params.video
      ? await prepareChannelSuggestionMediaRows([], params.video)
      : storeImageRows
        ? await prepareNormalizedChannelSuggestionImageRows(normalizedImages)
        : [];

    const created = await this.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.user.userId,
        action: CHANNEL_DIALOG_ACTION_SUGGEST,
        payload: {
          type: 'suggest',
          threadId: params.threadId,
          text: params.text,
          ...(params.textFormat === 'markdown' ? { textFormat: params.textFormat } : {}),
          ...(params.textMarkup && params.textMarkup.length > 0
            ? { textMarkup: params.textMarkup as Prisma.InputJsonValue }
            : {}),
          actorUserId: params.user.userId,
          authorDisplayName: resolveChannelSuggestionActorDisplayNameValue(params.user),
          authorUsername: this.readTrimmedString(params.user.username),
          authorProfileUrl:
            this.normalizeMaxProfileUrl(this.readTrimmedString(params.user.profileUrl)) ?? null,
          authorAvatarUrl: this.readTrimmedString(params.user.avatarUrl) ?? null,
          delivered: false,
          deliveredToUserId: null,
          deliveredToUserIds: [],
          suggestionDelivery: {
            state: 'queued',
            deliveredCount: 0,
            targetCount: 0,
            pendingCount: 0,
            unreachableCount: 0,
          },
          deliveries: [],
          source: params.source,
          reviewStatus: 'pending',
          ...(params.video || storeImageRows
            ? buildChannelSuggestionMediaMetadata(mediaRows)
            : {
                hasImage: normalizedImages.length > 0,
                imageCount: normalizedImages.length,
                imageFileNames,
                images: normalizedImages as Prisma.InputJsonValue,
                hasVideo: params.mediaType === 'video',
                imageBase64: null,
                imageMimeType: null,
                imageFileName: imageFileNames[0] ?? null,
                mediaType: params.mediaType ?? null,
                mediaPayload: (params.mediaPayload ?? null) as Prisma.InputJsonValue | null,
                mediaMimeType: params.mediaMimeType ?? null,
                mediaFileName: params.mediaFileName ?? null,
              }),
          mediaBotId: params.mediaBotId ?? null,
        },
        ...(mediaRows.length
          ? {
              channelSuggestionImageAssets: {
                create: mediaRows,
              },
            }
          : {}),
      },
      select: {
        id: true,
        chatId: true,
        actorUserId: true,
        payload: true,
        createdAt: true,
      },
    });

    if (await this.enqueueChannelSuggestionDelivery(created.id)) {
      return {
        row: created,
        delivered: false,
        deliveredToUserId: null,
        queued: true,
      };
    }

    const delivery = await this.deliverSuggestionToAdminPrivates(
      created.id,
      params.chatId,
      params.user,
      {
        text: params.text,
        ...(params.textFormat ? { textFormat: params.textFormat } : {}),
        ...(params.textMarkup ? { textMarkup: params.textMarkup } : {}),
        images: params.video ? [{ type: 'video', ...params.video }] : normalizedImages,
        imageBase64: params.imageBase64,
        imageMimeType: params.imageMimeType,
        imageFileName: params.imageFileName,
        mediaType: params.mediaType,
        mediaPayload: params.mediaPayload,
        mediaMimeType: params.mediaMimeType,
        mediaFileName: params.mediaFileName,
        mediaBotId: params.mediaBotId,
      },
    );
    const updated = await this.applyChannelSuggestionDeliveryResult(created, delivery);

    return {
      row: updated,
      delivered: delivery.delivered,
      deliveredToUserId: delivery.deliveredToUserId,
      queued: false,
    };
  }

  async processChannelSuggestionDeliveryJob(auditLogId: string): Promise<void> {
    await this.suggestionDeliveryRuntime.processChannelSuggestionDeliveryJob(auditLogId);
  }

  private async enqueuePublisherSuggestionAdminDelivery(suggestionId: string): Promise<void> {
    const requiredBotId = this.publisherDialogLinkService?.getBotId().trim() ?? '';
    if (!this.publisherSuggestionAdminQueueService || !requiredBotId) {
      throw new ServiceUnavailableException('Publisher suggestion delivery queue is unavailable');
    }
    await this.publisherSuggestionAdminQueueService.enqueueDelivery({
      suggestionId,
      requiredBotId,
    });
  }

  async processPublisherSuggestionAdminDeliveryJob(
    auditLogId: string,
    requiredBotId: string,
  ): Promise<void> {
    const scope = this.buildPublisherSuggestionAdminDeliveryScope(requiredBotId);
    await raceWithTimeout({
      operation: this.processChannelSuggestionDeliveryJobWithinTimeout(auditLogId, scope),
      timeoutMs: CHANNEL_SUGGESTION_DELIVERY_JOB_TIMEOUT_MS,
      onTimeout: () => {
        throw new Error(
          `Publisher suggestion admin delivery timed out after ${CHANNEL_SUGGESTION_DELIVERY_JOB_TIMEOUT_MS}ms`,
        );
      },
    });
  }

  async syncPublisherSuggestionAdminReviewMessages(
    suggestionId: string,
    requiredBotId: string,
  ): Promise<void> {
    const normalizedSuggestionId = suggestionId.trim();
    const botId = requiredBotId.trim();
    if (!normalizedSuggestionId || !botId) {
      return;
    }
    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: normalizedSuggestionId,
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
      },
      select: { id: true, chatId: true, payload: true },
    });
    if (!row) {
      return;
    }
    const payload = this.readObjectPayload(row.payload);
    const reviewStatus = this.readLowerString(payload.reviewStatus);
    if (
      reviewStatus !== 'published' &&
      reviewStatus !== 'drafted' &&
      reviewStatus !== 'cancelled'
    ) {
      return;
    }
    const syncedCount = await this.syncChannelSuggestionAdminReviewMessages(
      row.id,
      row.chatId,
      payload,
      botId,
      true,
      'publication_created',
    );
    if (syncedCount === 0) {
      return;
    }
    const syncPatch = JSON.stringify({
      publisherAdminCardSyncKey: buildPublisherSuggestionAdminSyncMarker(botId, reviewStatus),
      publisherAdminCardSyncedCount: syncedCount,
      publisherAdminCardSyncedAt: new Date().toISOString(),
    });
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE audit_logs audit
      SET payload = audit.payload::jsonb || ${syncPatch}::jsonb
      WHERE audit.id = ${row.id}::text
        AND audit.action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND audit.payload->>'reviewStatus' = ${reviewStatus}::text
        AND (
          SELECT COUNT(*)
          FROM channel_suggestion_admin_deliveries delivery
          WHERE delivery.audit_log_id = audit.id
            AND delivery.bot_key = ${`publisher:${botId}`}
            AND delivery.status = 'SENT'::"ChannelSuggestionAdminDeliveryStatus"
            AND delivery.private_chat_id IS NOT NULL
            AND delivery.remote_message_id IS NOT NULL
        ) = ${syncedCount}
    `);
  }

  async recoverStaleChannelSuggestionDeliveries(
    limit = CHANNEL_SUGGESTION_DELIVERY_RECOVERY_BATCH_SIZE,
  ): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.trunc(limit) : 1));
    const staleBefore = new Date(Date.now() - CHANNEL_SUGGESTION_DELIVERY_RECOVERY_STALE_MS);
    const terminalRecoveryFrom = new Date(
      Date.now() - CHANNEL_SUGGESTION_TERMINAL_RECOVERY_LOOKBACK_MS,
    );
    const staleClaims = await reconcileStaleChannelSuggestionDeliveryClaims({
      prisma: this.prisma,
      staleBefore,
      auditAction: CHANNEL_DIALOG_ACTION_SUGGEST,
      limit: boundedLimit,
    });
    const staleAuditLogIds = new Set(staleClaims.auditLogIds);
    const terminalLimit = Math.max(0, boundedLimit - staleAuditLogIds.size);
    const terminalAuditLogIds = new Set(
      terminalLimit === 0
        ? []
        : await findRecentRecoverableChannelSuggestionAuditLogIds({
            prisma: this.prisma,
            action: CHANNEL_DIALOG_ACTION_SUGGEST,
            recoveryFrom: terminalRecoveryFrom,
            staleBefore,
            limit: terminalLimit,
          }),
    );
    const remainingLimit = Math.max(
      0,
      boundedLimit - staleAuditLogIds.size - terminalAuditLogIds.size,
    );
    const retryableAuditLogIds =
      remainingLimit === 0
        ? []
        : await findRetryableChannelSuggestionAuditLogIds({
            prisma: this.prisma,
            action: CHANNEL_DIALOG_ACTION_SUGGEST,
            staleBefore,
            limit: remainingLimit,
          });

    let recovered = 0;
    const candidateIds = Array.from(
      new Set(
        [...staleAuditLogIds, ...terminalAuditLogIds, ...retryableAuditLogIds].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    );
    for (const candidateId of candidateIds) {
      if (await this.enqueueChannelSuggestionDelivery(candidateId, { recoverFailed: true })) {
        recovered += 1;
      }
    }

    return recovered;
  }

  async recordChannelSuggestionDeliveryJobFailure(
    auditLogId: string,
    error: unknown,
    metadata: { final: boolean; attemptsMade: number; maxAttempts: number },
  ): Promise<void> {
    const normalizedAuditLogId = auditLogId.trim();
    if (!normalizedAuditLogId) {
      return;
    }

    const row = await this.prisma.auditLog.findUnique({
      where: { id: normalizedAuditLogId },
      select: {
        id: true,
        chatId: true,
        actorUserId: true,
        action: true,
        payload: true,
        createdAt: true,
      },
    });
    if (!row || row.action !== CHANNEL_DIALOG_ACTION_SUGGEST) {
      return;
    }

    const payload = this.readObjectPayload(row.payload);
    let ledgerRows = await this.readChannelSuggestionAdminDeliveryLedgerRows(row.id);
    if (ledgerRows.length > 0) {
      await this.reconcileStaleChannelSuggestionAdminDeliveries(row.id);
      ledgerRows = await this.readChannelSuggestionAdminDeliveryLedgerRows(row.id);
      if (metadata.final) {
        const retryableRows = selectRetryableLogicalDeliveryRows(ledgerRows, (delivery) =>
          this.isRetryableChannelSuggestionAdminDeliveryRow(delivery),
        );
        if (retryableRows.length > 0) {
          const failure = this.buildChannelSuggestionDeliveryFailure({
            adminUserId: retryableRows[0]!.adminUserId,
            privateChatId: null,
            error,
          });
          await persistChannelSuggestionPreclaimFailure({
            prisma: this.prisma,
            rowIds: retryableRows.map((delivery) => delivery.id),
            failure,
          });
        }
      }
      await this.syncChannelSuggestionLegacyDeliveryPayload(row);
      return;
    }

    const reviewStatus = this.readLowerString(payload.reviewStatus);
    if (reviewStatus && reviewStatus !== 'pending') {
      return;
    }

    if (
      payload.delivered === true ||
      this.readTrimmedString(payload.deliveryAttemptedAt) ||
      this.readChannelSuggestionDeliveries(payload.deliveries).length > 0
    ) {
      return;
    }

    const failedAt = new Date().toISOString();
    const status = extractMaxErrorStatus(error);
    const code = extractMaxErrorCode(error);
    const message = extractMaxErrorMessage(error) || 'unknown delivery job failure';
    const recoverable = this.isRecoverableChannelSuggestionDeliveryJobError(error);
    const deliveryJobLastError = {
      message,
      status,
      code,
      recoverable,
      attemptsMade: Math.max(1, Math.trunc(metadata.attemptsMade)),
      maxAttempts: Math.max(1, Math.trunc(metadata.maxAttempts)),
      final: metadata.final,
    };

    const failurePatch: Record<string, unknown> = {
      delivered: false,
      deliveredToUserId: null,
      deliveredToUserIds: [],
      deliveries: [],
      deliveryJobLastFailedAt: failedAt,
      deliveryJobLastError,
      ...(metadata.final
        ? {
            deliveryJobFinalFailedAt: failedAt,
            deliveryJobRecoverable: recoverable,
          }
        : {}),
    };

    if (metadata.final && !recoverable) {
      failurePatch.suggestionDelivery = {
        state: 'uncertain',
        deliveredCount: 0,
        targetCount: 0,
        pendingCount: 0,
        unreachableCount: 0,
      };
      failurePatch.deliveryAttemptedAt = failedAt;
      failurePatch.deliveryFailures = [
        {
          adminUserId: 'delivery_job',
          privateChatId: null,
          status,
          code,
          terminal: true,
          recoverable: false,
          message,
        },
      ];
    } else if (metadata.final) {
      failurePatch.suggestionDelivery = {
        state: 'queued',
        deliveredCount: 0,
        targetCount: 0,
        pendingCount: 0,
        unreachableCount: 0,
      };
    }

    const failurePatchJson = JSON.stringify(failurePatch);
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE audit_logs audit
      SET payload = audit.payload::jsonb
        || ${failurePatchJson}::jsonb
        || jsonb_build_object(
          'deliveryJobFailureCount',
          CASE
            WHEN COALESCE(audit.payload->>'deliveryJobFailureCount', '') ~ '^[0-9]{1,18}$'
              THEN LEAST(
                (audit.payload->>'deliveryJobFailureCount')::bigint + 1,
                2147483647
              )
            ELSE 1
          END
        )
      WHERE audit.id = ${row.id}::text
        AND audit.action = ${CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND audit.payload->>'type' = 'suggest'
        AND COALESCE(NULLIF(audit.payload->>'reviewStatus', ''), 'pending') = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM channel_suggestion_admin_deliveries delivery
          WHERE delivery.audit_log_id = audit.id
        )
    `);
    if (Number(updated) === 0) {
      await this.syncChannelSuggestionLegacyDeliveryPayload(row);
    }
  }

  private async processChannelSuggestionDeliveryJobWithinTimeout(
    auditLogId: string,
    scope: ChannelSuggestionAdminDeliveryScope = {
      auditAction: CHANNEL_DIALOG_ACTION_SUGGEST,
      botKey: CHANNEL_SUGGESTION_ADMIN_DELIVERY_DEFAULT_BOT_KEY,
      requiredBotId: null,
      publisherOwned: false,
    },
  ): Promise<void> {
    const normalizedAuditLogId = auditLogId.trim();
    if (!normalizedAuditLogId) {
      return;
    }

    const row = await this.prisma.auditLog.findUnique({
      where: { id: normalizedAuditLogId },
      select: {
        id: true,
        chatId: true,
        actorUserId: true,
        action: true,
        payload: true,
        createdAt: true,
      },
    });
    if (!row || row.action !== scope.auditAction) {
      return;
    }

    const payload = this.readObjectPayload(row.payload);
    const reviewStatus = this.readLowerString(payload.reviewStatus);
    if (reviewStatus && reviewStatus !== 'pending') {
      return;
    }

    if (scope.publisherOwned) {
      await assertPublisherSuggestionDeliveryReady({
        prisma: this.prisma,
        readiness: this.publisherReadinessService,
        auditLogId: row.id,
        chatId: row.chatId,
        requiredBotId: scope.requiredBotId,
        setupBlockPresent: Boolean(payload.publisherAdminDeliverySetupBlock),
      });
    }

    const ledgerBotKey = scope.publisherOwned ? scope.botKey : undefined;
    await this.reconcileStaleChannelSuggestionAdminDeliveries(row.id, undefined, ledgerBotKey);
    let ledgerRows = await this.readChannelSuggestionAdminDeliveryLedgerRows(row.id, ledgerBotKey);
    if (
      row.createdAt.getTime() >= Date.now() - CHANNEL_SUGGESTION_TERMINAL_RECOVERY_LOOKBACK_MS &&
      ledgerRows.some((delivery) => isTerminalPrivateDialogDeliveryRow(delivery))
    ) {
      await recoverChannelSuggestionAdminDeliveriesAfterBotStarted({
        prisma: this.prisma,
        auditLogId: row.id,
        rows: ledgerRows,
        ...(scope.publisherOwned && scope.requiredBotId
          ? {
              options: {
                botKey: scope.botKey,
                botId: scope.requiredBotId,
                privateActivityTypes: ['bot_started', 'message_created'] as const,
              },
            }
          : {}),
      });
      ledgerRows = await this.readChannelSuggestionAdminDeliveryLedgerRows(row.id, ledgerBotKey);
    }
    if (ledgerRows.length > 0) {
      if (
        !ledgerRows.some((delivery) => this.isRetryableChannelSuggestionAdminDeliveryRow(delivery))
      ) {
        await this.syncChannelSuggestionLegacyDeliveryPayload(row, scope.auditAction, ledgerBotKey);
        return;
      }
    } else {
      const alreadyDelivered = payload.delivered === true;
      const deliveryAttemptedAt = this.readTrimmedString(payload.deliveryAttemptedAt);
      const deliveries = this.readChannelSuggestionDeliveries(payload.deliveries);
      const deliveryFailures = this.readChannelSuggestionDeliveryFailures(payload.deliveryFailures);
      const shouldRetryRecoverableDeliveryFailure =
        Boolean(deliveryAttemptedAt) &&
        deliveries.length === 0 &&
        this.hasRecoverableChannelSuggestionDeliveryFailure(deliveryFailures);
      if (
        alreadyDelivered ||
        deliveries.length > 0 ||
        (deliveryAttemptedAt && !shouldRetryRecoverableDeliveryFailure)
      ) {
        return;
      }
    }

    const images = await this.channelSuggestionImageRuntime.loadStoredImages(row.id, payload);
    const delivery = await this.deliverSuggestionToAdminPrivates(
      row.id,
      row.chatId,
      this.readStoredChannelSuggestionActor(row.actorUserId, payload),
      {
        text: this.readRawString(payload.text) ?? '',
        textFormat: this.normalizeBroadcastTextFormat(
          this.readTrimmedString(payload.textFormat) ?? 'plain',
        ),
        textMarkup: this.readChannelSuggestionTextMarkup(payload.textMarkup),
        images,
        mediaType: this.readChannelSuggestionMediaType(payload.mediaType),
        mediaPayload: this.readObjectPayloadOrNull(payload.mediaPayload),
        mediaMimeType: this.readTrimmedString(payload.mediaMimeType),
        mediaFileName: this.readTrimmedString(payload.mediaFileName),
        mediaBotId: this.readTrimmedString(payload.mediaBotId),
      },
      scope,
    );
    if (ledgerBotKey) {
      await this.applyChannelSuggestionDeliveryResult(
        row,
        delivery,
        scope.auditAction,
        ledgerBotKey,
        scope.requiredBotId ?? undefined,
      );
    } else {
      await this.applyChannelSuggestionDeliveryResult(row, delivery, scope.auditAction);
    }
  }

  private buildPublisherSuggestionAdminDeliveryScope(
    requiredBotId: string,
  ): ChannelSuggestionAdminDeliveryScope {
    const botId = requiredBotId.trim();
    if (!botId) {
      throw new BadRequestException('Publisher suggestion delivery bot id is required');
    }
    return {
      auditAction: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
      botKey: `publisher:${botId}`,
      requiredBotId: botId,
      publisherOwned: true,
    };
  }

  private async resolveChannelSuggestionAuthorAttribution(
    chatId: string,
    user: ChannelSuggestionActor,
    options: {
      botId?: string | null;
      trafficClass: 'interactive' | 'background';
    },
  ): Promise<ChannelSuggestionAuthorAttribution> {
    const loadProfiles = this.maxClient.getChatMemberProfiles?.bind(this.maxClient);
    return resolveChannelSuggestionAuthorAttributionValue({
      chatId,
      user,
      ...options,
      ...(typeof loadProfiles === 'function' ? { loadProfiles } : {}),
      loadLocalDisplayNames: (targetChatId, userIds) =>
        this.resolveUserDisplayNames(targetChatId, userIds),
      logger: this.logger,
    });
  }

  private readStoredChannelSuggestionActor(
    actorUserId: string,
    payload: Record<string, unknown>,
  ): ChannelSuggestionActor {
    return channelDialogValues.readStoredChannelSuggestionActor(actorUserId, payload);
  }

  private async enqueueChannelSuggestionDelivery(
    auditLogId: string,
    options: { recoverFailed?: boolean } = {},
  ): Promise<boolean> {
    return this.suggestionDeliveryRuntime.enqueueChannelSuggestionDelivery(auditLogId, options);
  }

  private async applyChannelSuggestionDeliveryResult(
    row: {
      id: string;
      chatId?: string;
      actorUserId: string;
      payload: Prisma.JsonValue;
      createdAt: Date;
    },
    delivery: ChannelSuggestionDeliveryResult,
    auditAction = CHANNEL_DIALOG_ACTION_SUGGEST,
    botKey?: string,
    publisherBotId?: string,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const lockKey = `channel-suggestion-delivery-sync:${row.id}`;
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::BIGINT))`,
      );
      await tx.$queryRaw(Prisma.sql`
        SELECT delivery.id
        FROM channel_suggestion_admin_deliveries delivery
        WHERE delivery.audit_log_id = ${row.id}
          ${botKey ? Prisma.sql`AND delivery.bot_key = ${botKey}` : Prisma.empty}
        ORDER BY delivery.id
        FOR UPDATE
      `);
      const ledgerRows = (await tx.channelSuggestionAdminDelivery.findMany({
        where: { auditLogId: row.id, ...(botKey ? { botKey } : {}) },
        orderBy: [{ adminUserId: 'asc' }, { botKey: 'asc' }],
      })) as ChannelSuggestionAdminDeliveryLedgerRow[];
      const synchronizedDelivery =
        ledgerRows.length > 0
          ? this.buildChannelSuggestionDeliveryResultFromLedgerRows(
              ledgerRows,
              delivery.deliveryAttemptedAt,
            )
          : delivery;
      const deliveryPatch: Record<string, unknown> = {
        delivered: synchronizedDelivery.delivered,
        deliveredToUserId: synchronizedDelivery.deliveredToUserId,
        deliveredToUserIds: synchronizedDelivery.deliveredToUserIds,
        suggestionDelivery: synchronizedDelivery.suggestionDelivery,
        deliveries: synchronizedDelivery.deliveries,
        deliveryAttemptedAt: synchronizedDelivery.deliveryAttemptedAt,
        deliveryFailures: synchronizedDelivery.deliveryFailures,
      };
      const deliveryPatchJson = JSON.stringify(deliveryPatch);
      const updatedRows = await tx.$queryRaw<
        Array<{
          id: string;
          chatId: string;
          actorUserId: string;
          payload: Prisma.JsonValue;
          createdAt: Date;
        }>
      >(Prisma.sql`
        UPDATE audit_logs audit
        SET payload = (
          audit.payload::jsonb || ${deliveryPatchJson}::jsonb
        )
          - 'deliveryJobLastError'
          - 'deliveryJobLastFailedAt'
          - 'deliveryJobFinalFailedAt'
          - 'deliveryJobFailureCount'
          - 'deliveryJobRecoverable'
        WHERE audit.id = ${row.id}::text
          AND audit.action = ${auditAction}::text
          AND audit.payload->>'type' = 'suggest'
        RETURNING
          audit.id,
          audit.chat_id AS "chatId",
          audit.actor_user_id AS "actorUserId",
          audit.payload,
          audit.created_at AS "createdAt"
      `);
      const fallbackPayloadRecord: Record<string, unknown> = {
        ...this.readObjectPayload(row.payload),
        ...deliveryPatch,
      };
      delete fallbackPayloadRecord.deliveryJobLastError;
      delete fallbackPayloadRecord.deliveryJobLastFailedAt;
      delete fallbackPayloadRecord.deliveryJobFinalFailedAt;
      delete fallbackPayloadRecord.deliveryJobFailureCount;
      delete fallbackPayloadRecord.deliveryJobRecoverable;
      const returned = updatedRows[0];
      return returned?.id === row.id &&
        returned.createdAt instanceof Date &&
        Boolean(this.readObjectPayloadOrNull(returned.payload))
        ? returned
        : {
            id: row.id,
            chatId: row.chatId ?? '',
            actorUserId: row.actorUserId,
            payload: fallbackPayloadRecord as Prisma.JsonValue,
            createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(),
          };
    });
    const latestPayload = this.readObjectPayload(updated.payload);
    const latestReviewStatus = this.readLowerString(latestPayload.reviewStatus);
    if (
      updated.chatId &&
      (latestReviewStatus === 'published' ||
        latestReviewStatus === 'drafted' ||
        latestReviewStatus === 'cancelled')
    ) {
      if (publisherBotId) {
        await this.syncChannelSuggestionAdminReviewMessages(
          updated.id,
          updated.chatId,
          latestPayload,
          publisherBotId,
          false,
          'publication_created',
        );
      } else {
        await this.syncChannelSuggestionAdminReviewMessages(
          updated.id,
          updated.chatId,
          latestPayload,
        );
      }
    }
    return updated;
  }

  private isRetryableChannelSuggestionAdminDeliveryRow(
    row: Pick<
      ChannelSuggestionAdminDeliveryLedgerRow,
      'status' | 'terminal' | 'lastStatusCode' | 'lastErrorCode' | 'lastError'
    >,
  ): boolean {
    if (row.status === PrismaChannelSuggestionAdminDeliveryStatus.PENDING) {
      return true;
    }
    if (row.status !== PrismaChannelSuggestionAdminDeliveryStatus.FAILED || row.terminal) {
      return false;
    }

    return this.isRecoverableChannelSuggestionDeliveryFailureData({
      status: row.lastStatusCode,
      code: row.lastErrorCode,
      message: row.lastError ?? '',
    });
  }

  private mapChannelSuggestionAdminDeliveryRowToLegacyDelivery(
    row: ChannelSuggestionAdminDeliveryLedgerRow,
  ): ChannelSuggestionAdminDelivery | null {
    if (
      row.status !== PrismaChannelSuggestionAdminDeliveryStatus.SENT ||
      !row.privateChatId ||
      !row.remoteMessageId
    ) {
      return null;
    }

    return {
      adminUserId: row.adminUserId,
      privateChatId: row.privateChatId,
      messageId: row.remoteMessageId,
      ...(row.botId ? { botId: row.botId } : {}),
    };
  }

  private mapChannelSuggestionAdminDeliveryRowToLegacyFailure(
    row: ChannelSuggestionAdminDeliveryLedgerRow,
  ): ChannelSuggestionAdminDeliveryFailure | null {
    if (
      row.status !== PrismaChannelSuggestionAdminDeliveryStatus.FAILED &&
      row.status !== PrismaChannelSuggestionAdminDeliveryStatus.AMBIGUOUS
    ) {
      return null;
    }

    const ambiguous = row.status === PrismaChannelSuggestionAdminDeliveryStatus.AMBIGUOUS;
    return {
      adminUserId: row.adminUserId,
      privateChatId: row.privateChatId,
      ...(row.botId ? { botId: row.botId } : {}),
      status: row.lastStatusCode,
      code: row.lastErrorCode,
      terminal: ambiguous ? false : row.terminal,
      recoverable: ambiguous ? false : this.isRetryableChannelSuggestionAdminDeliveryRow(row),
      message: row.lastError ?? (ambiguous ? 'ambiguous send timeout' : ''),
    };
  }

  private buildChannelSuggestionDeliveryResultFromLedgerRows(
    rows: ChannelSuggestionAdminDeliveryLedgerRow[],
    deliveryAttemptedAt: string,
  ): ChannelSuggestionDeliveryResult {
    const deliveredToUserIds = Array.from(
      new Set(
        rows
          .filter((row) => row.status === PrismaChannelSuggestionAdminDeliveryStatus.SENT)
          .map((row) => row.adminUserId),
      ),
    );
    const deliveries = rows
      .map((row) => this.mapChannelSuggestionAdminDeliveryRowToLegacyDelivery(row))
      .filter((entry): entry is ChannelSuggestionAdminDelivery => entry !== null);
    const deliveryFailures = rows
      .map((row) => this.mapChannelSuggestionAdminDeliveryRowToLegacyFailure(row))
      .filter((entry): entry is ChannelSuggestionAdminDeliveryFailure => entry !== null);
    const suggestionDelivery = buildChannelSuggestionDeliverySnapshot(
      rows.map((row) => ({
        adminUserId: row.adminUserId,
        status: row.status,
        terminal: row.terminal,
        lastStatusCode: row.lastStatusCode,
        lastErrorCode: row.lastErrorCode,
        retryable: this.isRetryableChannelSuggestionAdminDeliveryRow(row),
      })),
    );

    return {
      delivered: deliveredToUserIds.length > 0,
      deliveredToUserId: deliveredToUserIds[0] ?? null,
      deliveredToUserIds,
      suggestionDelivery,
      deliveries,
      deliveryAttemptedAt,
      deliveryFailures,
    };
  }

  private async readChannelSuggestionAdminDeliveryLedgerRows(
    auditLogId: string,
    botKey?: string,
  ): Promise<ChannelSuggestionAdminDeliveryLedgerRow[]> {
    return (await this.prisma.channelSuggestionAdminDelivery.findMany({
      where: { auditLogId, ...(botKey ? { botKey } : {}) },
      orderBy: [{ adminUserId: 'asc' }, { botKey: 'asc' }],
    })) as ChannelSuggestionAdminDeliveryLedgerRow[];
  }

  private async syncChannelSuggestionLegacyDeliveryPayload(
    row: {
      id: string;
      chatId?: string;
      actorUserId?: string;
      payload: Prisma.JsonValue;
      createdAt?: Date;
    },
    auditAction = CHANNEL_DIALOG_ACTION_SUGGEST,
    botKey?: string,
  ): Promise<{
    id: string;
    chatId: string;
    actorUserId: string;
    payload: Prisma.JsonValue;
    createdAt: Date;
  } | null> {
    const ledgerRows = await this.readChannelSuggestionAdminDeliveryLedgerRows(row.id, botKey);
    if (ledgerRows.length === 0) {
      return null;
    }
    const deliveryAttemptedAt =
      this.readTrimmedString(this.readObjectPayload(row.payload).deliveryAttemptedAt) ??
      row.createdAt?.toISOString() ??
      new Date(0).toISOString();

    const synchronizedRow = {
      id: row.id,
      chatId: row.chatId,
      actorUserId: row.actorUserId ?? '',
      payload: row.payload,
      createdAt: row.createdAt ?? new Date(),
    };
    const delivery = this.buildChannelSuggestionDeliveryResultFromLedgerRows(
      ledgerRows,
      deliveryAttemptedAt,
    );
    return botKey
      ? this.applyChannelSuggestionDeliveryResult(synchronizedRow, delivery, auditAction, botKey)
      : this.applyChannelSuggestionDeliveryResult(synchronizedRow, delivery, auditAction);
  }

  private async reconcileStaleChannelSuggestionAdminDeliveries(
    auditLogId: string,
    staleBefore = new Date(Date.now() - CHANNEL_SUGGESTION_DELIVERY_RECOVERY_STALE_MS),
    botKey?: string,
  ): Promise<void> {
    await reconcileStaleChannelSuggestionDeliveryClaims({
      prisma: this.prisma,
      auditLogId,
      staleBefore,
      ...(botKey ? { botKey } : {}),
    });
  }

  private async assertChannelSuggestionDailyLimit(
    chatId: string,
    userId: string,
    settings: Pick<ChannelSettings, 'postSuggestionsDailyLimit'>,
  ): Promise<void> {
    const limit = Math.max(1, Math.min(10, Math.trunc(settings.postSuggestionsDailyLimit)));
    const recentSuggestionsCount = await this.prisma.auditLog.count({
      where: {
        chatId,
        actorUserId: userId,
        action: CHANNEL_DIALOG_ACTION_SUGGEST,
        createdAt: {
          gte: new Date(Date.now() - TWENTY_FOUR_HOURS_MS),
        },
      },
    });

    if (recentSuggestionsCount >= limit) {
      throw new BadRequestException(
        `Лимит предложек для этого канала исчерпан: ${limit} за последние 24 часа. Попробуйте позже.`,
      );
    }
  }

  private async resolvePublisherSuggestionAdminUserIds(
    chatId: string,
    publisherBotId?: string | null,
  ): Promise<string[]> {
    const botId = this.readTrimmedString(publisherBotId);
    if (!botId) {
      return [];
    }
    const rows = await this.prisma.managedEntityAccessEdge.findMany({
      where: {
        chatId,
        botId,
        entityType: ChatEntityType.CHANNEL,
        state: ManagedEntityAccessState.GRANTED,
        userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
      },
      select: { userId: true },
      orderBy: [{ checkedAt: 'desc' }, { userId: 'asc' }],
    });
    return Array.from(
      new Set(rows.map((row) => row.userId.trim()).filter((userId) => userId.length > 0)),
    );
  }

  private async resolveChannelSuggestionRosterAdminUserIds(
    chatId: string,
    options: Parameters<MaxClientService['getChatAdminMembers']>[1],
  ): Promise<string[]> {
    const richAdminLookup = (
      this.maxClient as MaxClientService & {
        getChatAdminMembers?: (
          lookupChatId: string,
          lookupOptions?: Parameters<MaxClientService['getChatAdminMembers']>[1],
        ) => Promise<MaxChatAdminMember[]>;
      }
    ).getChatAdminMembers;
    return typeof richAdminLookup === 'function'
      ? (await richAdminLookup.call(this.maxClient, chatId, options))
          .filter((member) => member.isBot !== true)
          .map((member) => member.userId)
      : this.maxClient.getChatAdminIds(chatId, options);
  }

  private async reconcilePublisherSuggestionEditors(
    adminUserIds: string[],
    retryableRows: ChannelSuggestionAdminDeliveryLedgerRow[],
  ): Promise<string[]> {
    const current = new Set(adminUserIds);
    const removedRows = retryableRows.filter((row) => !current.has(row.adminUserId));
    if (removedRows.length > 0) {
      await persistChannelSuggestionPreclaimFailure({
        prisma: this.prisma,
        rowIds: removedRows.map((row) => row.id),
        failure: {
          message: 'editor has no fresh Publisher-owned access edge',
          status: 503,
          code: 'suggestion.delivery.publisher_edge_unavailable',
          terminal: false,
          recoverable: true,
        },
        incrementAttemptCount: false,
      });
    }
    return adminUserIds;
  }

  private async resolveKnownBotUserIdsForExactBot(
    chatId: string,
    botId?: string | null,
  ): Promise<Set<string>> {
    const known = new Set<string>();
    for (const value of [this.ownBotUserId, this.explicitBotContactId]) {
      const normalized = this.readTrimmedString(value);
      if (normalized) known.add(normalized);
    }
    const currentBotUserId = await this.resolveCurrentBotUserId(chatId, botId);
    if (currentBotUserId) known.add(currentBotUserId);
    return known;
  }

  private async deliverSuggestionToAdminPrivates(
    suggestionId: string,
    chatId: string,
    user: ChannelSuggestionActor,
    suggestion: ChannelSuggestionDeliveryInput,
    scope: ChannelSuggestionAdminDeliveryScope = {
      auditAction: CHANNEL_DIALOG_ACTION_SUGGEST,
      botKey: CHANNEL_SUGGESTION_ADMIN_DELIVERY_DEFAULT_BOT_KEY,
      requiredBotId: null,
      publisherOwned: false,
    },
  ): Promise<ChannelSuggestionDeliveryResult> {
    const deliveryAttemptedAt = new Date().toISOString();
    const ledgerBotKey = scope.publisherOwned ? scope.botKey : undefined;
    const deliveryBotId =
      scope.requiredBotId ??
      (await this.resolveAssistBotAssignment(chatId, 'suggestion_delivery')) ??
      null;
    const privateDeliveryBotId = this.resolvePrivateDeliveryBotId(deliveryBotId);
    const knownBotUserIds = scope.publisherOwned
      ? await this.resolveKnownBotUserIdsForExactBot(chatId, privateDeliveryBotId)
      : await this.resolveKnownBotUserIdsForChat(chatId, [deliveryBotId]);
    const adminLookupOptions = {
      trafficClass: 'background' as const,
      sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      timeoutMs: CHANNEL_SUGGESTION_ADMIN_LOOKUP_TIMEOUT_MS,
      bypassCache: true,
      ...(deliveryBotId ? { botId: deliveryBotId } : {}),
    };
    const adminIdsFromRoster = scope.publisherOwned
      ? await this.resolvePublisherSuggestionAdminUserIds(chatId, privateDeliveryBotId)
      : await this.resolveChannelSuggestionRosterAdminUserIds(chatId, adminLookupOptions);
    const rosterAdminIds = Array.from(
      new Set(
        adminIdsFromRoster
          .map((id) => id.trim())
          .filter(
            (id) =>
              id.length > 0 &&
              !knownBotUserIds.has(id) &&
              !this.dialogLinkHelper.isOwnBotUserId(id),
          ),
      ),
    );
    const existingLedgerRows = await this.readChannelSuggestionAdminDeliveryLedgerRows(
      suggestionId,
      ledgerBotKey,
    );
    const retryableExistingRows = existingLedgerRows.filter((row) =>
      this.isRetryableChannelSuggestionAdminDeliveryRow(row),
    );
    const adminIds = scope.publisherOwned
      ? await this.reconcilePublisherSuggestionEditors(rosterAdminIds, retryableExistingRows)
      : await reconcileAuthoritativeChannelSuggestionEditorRoster({
          prisma: this.prisma,
          rosterAdminUserIds: rosterAdminIds,
          retryableRows: retryableExistingRows,
          knownBotUserIds,
          isOwnBotUserId: (userId) => this.dialogLinkHelper.isOwnBotUserId(userId),
          ...(typeof this.maxClient.getChatMembersAccess === 'function'
            ? {
                loadMissingAccess: (userIds: string[]) =>
                  this.maxClient.getChatMembersAccess(chatId, userIds, adminLookupOptions),
              }
            : {}),
          onConfirmationError: (error, adminUserIds) =>
            this.logger.warn(
              {
                suggestionId,
                chatId,
                adminUserIds,
                err: error instanceof Error ? error.message : String(error),
              },
              'Could not confirm suggestion editors missing from the fresh admin roster',
            ),
        });

    if (adminIds.length === 0) {
      const rows = await this.readChannelSuggestionAdminDeliveryLedgerRows(
        suggestionId,
        ledgerBotKey,
      );
      if (rows.length > 0) {
        return this.buildChannelSuggestionDeliveryResultFromLedgerRows(rows, deliveryAttemptedAt);
      }
      return {
        delivered: false,
        deliveredToUserId: null,
        deliveredToUserIds: [],
        suggestionDelivery: {
          state: 'queued',
          deliveredCount: 0,
          targetCount: 0,
          pendingCount: 0,
          unreachableCount: 0,
        },
        deliveries: [],
        deliveryAttemptedAt,
        deliveryFailures: [
          {
            adminUserId: 'delivery_job',
            privateChatId: null,
            status: 503,
            code: 'suggestion.delivery.roster_empty',
            terminal: false,
            recoverable: true,
            message: 'fresh channel admin roster is empty; retrying delivery discovery',
          },
        ],
      };
    }

    const routePlan = resolveChannelSuggestionPrivateDeliveryRoutePlan({
      suggestion,
      preferredBotId: privateDeliveryBotId,
      actionableBotIds: scope.publisherOwned
        ? privateDeliveryBotId
          ? [privateDeliveryBotId]
          : []
        : typeof this.maxBotRegistry?.getActionableBots === 'function'
          ? this.maxBotRegistry.getActionableBots().map((bot) => bot.id)
          : null,
    });
    const routesByAdminUserId = new Map<string, ChannelSuggestionPrivateDeliveryRoute[]>();
    if (!routePlan.routeError && routePlan.botIds.length > 0) {
      await mapWithConcurrencyLimit(
        adminIds,
        CHANNEL_SUGGESTION_PRIVATE_ROUTE_LOOKUP_CONCURRENCY,
        async (adminUserId) => {
          routesByAdminUserId.set(
            adminUserId,
            await this.findLatestPrivateChatRoutesForUser(adminUserId, routePlan.botIds),
          );
        },
      );
    }

    const existingAdminUserIds = new Set(existingLedgerRows.map((row) => row.adminUserId));
    await this.prisma.channelSuggestionAdminDelivery.createMany({
      data: adminIds
        .filter((adminUserId) => !existingAdminUserIds.has(adminUserId))
        .map((adminUserId) => ({
          auditLogId: suggestionId,
          adminUserId,
          botKey: scope.botKey,
          botId: privateDeliveryBotId ?? null,
          status: PrismaChannelSuggestionAdminDeliveryStatus.PENDING,
        })),
      skipDuplicates: true,
    });
    await this.reconcileStaleChannelSuggestionAdminDeliveries(
      suggestionId,
      undefined,
      ledgerBotKey,
    );
    const ledgerRows = await this.readChannelSuggestionAdminDeliveryLedgerRows(
      suggestionId,
      ledgerBotKey,
    );
    const retryableLedgerRows = selectRetryableLogicalDeliveryRows(
      ledgerRows.filter((row) => adminIds.includes(row.adminUserId)),
      (row) => this.isRetryableChannelSuggestionAdminDeliveryRow(row),
    );

    const hasReachableRoute = retryableLedgerRows.some(
      (row) =>
        mergeChannelSuggestionPrivateDeliveryRoutes({
          ledgerRoute: row,
          discoveredRoutes: routesByAdminUserId.get(row.adminUserId) ?? [],
          allowedBotIds: routePlan.botIds,
        }).length > 0,
    );
    let messagePayload: ReturnType<typeof buildChannelSuggestionAdminMessagePayloadValue> | null =
      null;
    if (hasReachableRoute) {
      try {
        messagePayload = buildChannelSuggestionAdminMessagePayloadValue({
          status: 'pending',
          channelTitle: await this.resolveChannelTitle(chatId, {
            sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
            timeoutMs: CHANNEL_SUGGESTION_ADMIN_LOOKUP_TIMEOUT_MS,
            ...(deliveryBotId ? { botId: deliveryBotId } : {}),
          }),
          authorAttribution: await this.resolveChannelSuggestionAuthorAttribution(chatId, user, {
            botId: deliveryBotId,
            trafficClass: 'background',
          }),
          text: suggestion.text,
          textFormat: suggestion.textFormat ?? 'plain',
          textMarkup: suggestion.textMarkup ?? [],
          reviewedBy: null,
          publishedUrl: null,
        });
      } catch (error: unknown) {
        const failure = this.buildChannelSuggestionDeliveryFailure({
          adminUserId: retryableLedgerRows[0]!.adminUserId,
          privateChatId: null,
          botId: privateDeliveryBotId,
          error,
        });
        await persistChannelSuggestionPreclaimFailure({
          prisma: this.prisma,
          rowIds: retryableLedgerRows.map((row) => row.id),
          failure,
          route: { privateChatId: null, botId: privateDeliveryBotId ?? null },
        });
        this.logger.warn(
          {
            suggestionId,
            chatId,
            recoverable: failure.recoverable,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to prepare shared suggestion delivery content before delivery claim',
        );
        return this.buildChannelSuggestionDeliveryResultFromLedgerRows(
          await this.readChannelSuggestionAdminDeliveryLedgerRows(suggestionId, ledgerBotKey),
          deliveryAttemptedAt,
        );
      }
    }
    const buttons = scope.publisherOwned
      ? this.buildPublisherSuggestionAdminReviewButtons(suggestionId)
      : this.buildChannelSuggestionAdminReviewButtons(suggestionId);
    const messageOptionsByBotId = new Map<
      string,
      Promise<
        Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
      >
    >();
    const getMessageOptions = (botId: string) => {
      let prepared = messageOptionsByBotId.get(botId);
      if (!prepared) {
        prepared = this.buildChannelSuggestionMessageOptions(suggestion, buttons, botId).then(
          (baseMessageOptions) => ({
            ...baseMessageOptions,
            textFormat: messagePayload?.textFormat ?? 'markdown',
          }),
        );
        messageOptionsByBotId.set(botId, prepared);
      }
      return prepared;
    };

    const settleFailure = async (params: {
      ledgerRow: ChannelSuggestionAdminDeliveryLedgerRow;
      lockToken: string;
      privateChatId: string | null;
      botId: string | null;
      error: unknown;
      sendAttempted: boolean;
    }) => {
      const ambiguous = params.sendAttempted && isAmbiguousMaxSendError(params.error);
      const deliveryFailure = this.buildChannelSuggestionDeliveryFailure({
        adminUserId: params.ledgerRow.adminUserId,
        privateChatId: params.privateChatId,
        botId: params.botId,
        error: params.error,
        allowPrivateDialogUnavailable: params.sendAttempted,
      });
      await this.prisma.channelSuggestionAdminDelivery.updateMany({
        where: {
          id: params.ledgerRow.id,
          status: PrismaChannelSuggestionAdminDeliveryStatus.SENDING,
          lockToken: params.lockToken,
        },
        data: {
          status: ambiguous
            ? PrismaChannelSuggestionAdminDeliveryStatus.AMBIGUOUS
            : PrismaChannelSuggestionAdminDeliveryStatus.FAILED,
          privateChatId: params.privateChatId,
          botId: params.botId,
          lockedAt: null,
          lockToken: null,
          lastError: deliveryFailure.message,
          lastStatusCode: deliveryFailure.status,
          lastErrorCode: deliveryFailure.code,
          terminal: ambiguous ? false : deliveryFailure.terminal || !deliveryFailure.recoverable,
        },
      });

      const logPayload = {
        suggestionId,
        chatId,
        adminUserId: params.ledgerRow.adminUserId,
        privateChatId: params.privateChatId,
        status: deliveryFailure.status,
        code: deliveryFailure.code,
        botId: params.botId,
        err: params.error instanceof Error ? params.error.message : String(params.error),
      };
      if (ambiguous) {
        this.logger.warn(
          logPayload,
          'Suggestion delivery to admin private chat is ambiguous after send timeout',
        );
      } else if (deliveryFailure.terminal || !deliveryFailure.recoverable) {
        this.logger.debug(
          logPayload,
          'Skipped suggestion delivery to unavailable admin private chat',
        );
      } else {
        this.logger.warn(logPayload, 'Failed to deliver suggestion to admin private chat');
      }
    };

    for (const ledgerRow of retryableLedgerRows) {
      const deliveryRoutes = mergeChannelSuggestionPrivateDeliveryRoutes({
        ledgerRoute: ledgerRow,
        discoveredRoutes: routesByAdminUserId.get(ledgerRow.adminUserId) ?? [],
        allowedBotIds: routePlan.botIds,
      });
      if (routePlan.routeError || !messagePayload || deliveryRoutes.length === 0) {
        const lockToken = randomUUID();
        const botId = routePlan.failureBotId ?? privateDeliveryBotId ?? null;
        const claimed = await this.prisma.channelSuggestionAdminDelivery.updateMany({
          where: {
            id: ledgerRow.id,
            status: {
              in: [
                PrismaChannelSuggestionAdminDeliveryStatus.PENDING,
                PrismaChannelSuggestionAdminDeliveryStatus.FAILED,
              ],
            },
            terminal: false,
          },
          data: {
            status: PrismaChannelSuggestionAdminDeliveryStatus.SENDING,
            privateChatId: null,
            botId,
            lockedAt: new Date(),
            lockToken,
            attemptCount: { increment: 1 },
            lastError: null,
            lastStatusCode: null,
            lastErrorCode: CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE,
            terminal: false,
          },
        });
        if (claimed.count === 0) {
          continue;
        }
        await settleFailure({
          ledgerRow,
          lockToken,
          privateChatId: null,
          botId,
          error:
            routePlan.routeError ??
            createChannelSuggestionDeliveryRouteError(
              404,
              'suggestion.delivery.no_reachable_dialog',
              'admin has not started an actionable suggestion delivery bot',
            ),
          sendAttempted: false,
        });
        continue;
      }

      for (let routeIndex = 0; routeIndex < deliveryRoutes.length; routeIndex += 1) {
        const route = deliveryRoutes[routeIndex]!;
        let messageOptions: Awaited<ReturnType<typeof getMessageOptions>>;
        try {
          messageOptions = await getMessageOptions(route.botId);
        } catch (error: unknown) {
          if (routeIndex + 1 < deliveryRoutes.length) {
            this.logger.debug(
              {
                suggestionId,
                adminUserId: ledgerRow.adminUserId,
                botId: route.botId,
                err: error instanceof Error ? error.message : String(error),
              },
              'Retrying suggestion media preparation through another known admin bot route',
            );
            continue;
          }
          const failure = this.buildChannelSuggestionDeliveryFailure({
            adminUserId: ledgerRow.adminUserId,
            privateChatId: route.privateChatId,
            botId: route.botId,
            error,
          });
          const failed = await persistChannelSuggestionPreclaimFailure({
            prisma: this.prisma,
            rowIds: [ledgerRow.id],
            failure,
            route: { privateChatId: route.privateChatId, botId: route.botId },
          });
          if (failed === 1) {
            this.logger.warn(
              {
                suggestionId,
                adminUserId: ledgerRow.adminUserId,
                botId: route.botId,
                recoverable: failure.recoverable,
                err: error instanceof Error ? error.message : String(error),
              },
              'Failed to prepare suggestion media before delivery claim',
            );
          }
          break;
        }
        const lockToken = randomUUID();
        const claimed = await this.prisma.channelSuggestionAdminDelivery.updateMany({
          where: {
            id: ledgerRow.id,
            status: {
              in: [
                PrismaChannelSuggestionAdminDeliveryStatus.PENDING,
                PrismaChannelSuggestionAdminDeliveryStatus.FAILED,
              ],
            },
            terminal: false,
          },
          data: {
            status: PrismaChannelSuggestionAdminDeliveryStatus.SENDING,
            privateChatId: route.privateChatId,
            botId: route.botId,
            lockedAt: new Date(),
            lockToken,
            attemptCount: { increment: 1 },
            lastError: null,
            lastStatusCode: null,
            lastErrorCode: CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE,
            terminal: false,
          },
        });
        if (claimed.count === 0) break;

        let dispatchGuardPassed = false;
        let published: Awaited<
          ReturnType<typeof this.sendChannelSuggestionAdminMessageWithRetry>
        > | null = null;
        try {
          published = await this.sendChannelSuggestionAdminMessageWithRetry({
            privateChatId: route.privateChatId,
            message: messagePayload.text,
            options: messageOptions,
            botId: route.botId,
            beforeSend: async () => {
              await assertChannelSuggestionEditorBeforeDispatch({
                adminUserId: ledgerRow.adminUserId,
                knownBotUserIds,
                isOwnBotUserId: (userId) => this.dialogLinkHelper.isOwnBotUserId(userId),
                loadAccess: async () => {
                  if (typeof this.maxClient.getChatMembersAccess === 'function') {
                    return (
                      (
                        await this.maxClient.getChatMembersAccess(
                          chatId,
                          [ledgerRow.adminUserId],
                          adminLookupOptions,
                        )
                      ).get(ledgerRow.adminUserId) ?? null
                    );
                  }
                  const freshAdminIds = await this.maxClient.getChatAdminIds(
                    chatId,
                    adminLookupOptions,
                  );
                  return freshAdminIds.includes(ledgerRow.adminUserId)
                    ? { isAdmin: true, isOwner: false }
                    : null;
                },
              });
              const renewed = await this.prisma.channelSuggestionAdminDelivery.updateMany({
                where: {
                  id: ledgerRow.id,
                  status: PrismaChannelSuggestionAdminDeliveryStatus.SENDING,
                  lockToken,
                },
                data: {
                  lockedAt: new Date(),
                  lastErrorCode: CHANNEL_SUGGESTION_DELIVERY_DISPATCH_STARTED_CODE,
                },
              });
              if (renewed.count !== 1) {
                throw createChannelSuggestionDeliveryRouteError(
                  409,
                  'suggestion.delivery.lock_lost',
                  'suggestion delivery ownership was lost before dispatch',
                );
              }
              dispatchGuardPassed = true;
            },
            onAttemptStart: async () => {
              dispatchGuardPassed = false;
              const reset = await this.prisma.channelSuggestionAdminDelivery.updateMany({
                where: {
                  id: ledgerRow.id,
                  status: PrismaChannelSuggestionAdminDeliveryStatus.SENDING,
                  lockToken,
                },
                data: {
                  lockedAt: new Date(),
                  lastErrorCode: CHANNEL_SUGGESTION_DELIVERY_PRE_DISPATCH_CODE,
                },
              });
              if (reset.count !== 1) {
                throw createChannelSuggestionDeliveryRouteError(
                  409,
                  'suggestion.delivery.lock_lost',
                  'suggestion delivery ownership was lost before dispatch preparation',
                );
              }
            },
          });
          const finalized = await finalizeConfirmedChannelSuggestionDelivery({
            prisma: this.prisma,
            rowId: ledgerRow.id,
            lockToken,
            privateChatId: this.readTrimmedString(published.chatId) ?? route.privateChatId,
            botId: route.botId,
            remoteMessageId: published.messageId,
          });
          if (!finalized) {
            this.logger.warn(
              { suggestionId, adminUserId: ledgerRow.adminUserId, botId: route.botId },
              'Suggestion delivery completed after ledger ownership was lost',
            );
          }
          break;
        } catch (error: unknown) {
          if (published) {
            this.logger.warn(
              { suggestionId, adminUserId: ledgerRow.adminUserId, botId: route.botId },
              'Suggestion send succeeded but confirmed delivery could not be persisted',
            );
            throw error;
          }
          const routeFailure = this.buildChannelSuggestionDeliveryFailure({
            adminUserId: ledgerRow.adminUserId,
            privateChatId: route.privateChatId,
            botId: route.botId,
            error,
            allowPrivateDialogUnavailable: dispatchGuardPassed,
          });
          if (
            routeFailure.code === 'suggestion.delivery.dialog_unavailable' &&
            routeIndex + 1 < deliveryRoutes.length
          ) {
            const nextRoute = deliveryRoutes[routeIndex + 1]!;
            const released = await this.prisma.channelSuggestionAdminDelivery.updateMany({
              where: {
                id: ledgerRow.id,
                status: PrismaChannelSuggestionAdminDeliveryStatus.SENDING,
                lockToken,
              },
              data: {
                status: PrismaChannelSuggestionAdminDeliveryStatus.PENDING,
                privateChatId: nextRoute.privateChatId,
                botId: nextRoute.botId,
                lockedAt: null,
                lockToken: null,
                lastError: null,
                lastStatusCode: null,
                lastErrorCode: null,
                terminal: false,
              },
            });
            if (released.count !== 1) break;
            this.logger.debug(
              {
                suggestionId,
                chatId,
                adminUserId: ledgerRow.adminUserId,
                botId: route.botId,
                privateChatId: route.privateChatId,
              },
              'Retrying suggestion delivery through another known admin private dialog',
            );
            continue;
          }
          await settleFailure({
            ledgerRow,
            lockToken,
            privateChatId: route.privateChatId,
            botId: route.botId,
            error,
            sendAttempted: dispatchGuardPassed,
          });
          break;
        }
      }
    }

    return this.buildChannelSuggestionDeliveryResultFromLedgerRows(
      await this.readChannelSuggestionAdminDeliveryLedgerRows(suggestionId, ledgerBotKey),
      deliveryAttemptedAt,
    );
  }

  private buildChannelSuggestionDeliveryFailure(params: {
    adminUserId: string;
    privateChatId: string | null;
    botId?: string | null;
    error: unknown;
    allowPrivateDialogUnavailable?: boolean;
  }): ChannelSuggestionAdminDeliveryFailure {
    const status = extractMaxErrorStatus(params.error);
    const sourceCode = extractMaxErrorCode(params.error);
    const message = extractMaxErrorMessage(params.error);
    const recoverable = this.isRecoverableChannelSuggestionDeliveryFailureData({
      status,
      code: sourceCode,
      message,
    });
    const privateDialogUnavailable =
      params.allowPrivateDialogUnavailable === true &&
      !recoverable &&
      isPrivateDialogChatUnavailableError(params.error);
    const isVersionedDeliveryCode = sourceCode?.startsWith('suggestion.delivery.') === true;
    const code =
      privateDialogUnavailable && !isVersionedDeliveryCode
        ? 'suggestion.delivery.dialog_unavailable'
        : !params.allowPrivateDialogUnavailable && !isVersionedDeliveryCode
          ? 'suggestion.delivery.preclaim_failed'
          : sourceCode;
    const terminal =
      privateDialogUnavailable ||
      sourceCode === 'suggestion.media.provenance.unknown' ||
      sourceCode === 'suggestion.delivery.dialog_unavailable' ||
      sourceCode === 'suggestion.delivery.editor_removed' ||
      sourceCode === 'suggestion.delivery.no_reachable_dialog';
    return {
      adminUserId: params.adminUserId,
      privateChatId: params.privateChatId,
      ...(params.botId ? { botId: params.botId } : {}),
      status,
      code,
      terminal,
      recoverable: !terminal && recoverable,
      message,
    };
  }

  private isRecoverableChannelSuggestionDeliveryJobError(error: unknown): boolean {
    const status = extractMaxErrorStatus(error);
    const code = extractMaxErrorCode(error);
    const message = extractMaxErrorMessage(error);
    return this.isRecoverableChannelSuggestionDeliveryFailureData({ status, code, message });
  }

  private isRecoverableChannelSuggestionDeliveryFailureData(params: {
    status: number | null;
    code: string | null;
    message: string;
  }): boolean {
    if (
      params.status === 408 ||
      params.status === 429 ||
      (typeof params.status === 'number' && params.status >= 500)
    ) {
      return true;
    }

    const normalizedCode = params.code?.trim().toLowerCase() ?? '';
    const message = params.message.toLowerCase();
    if (normalizedCode === 'attachment.not.ready' || message.includes('attachment.not.ready')) {
      return true;
    }

    if (typeof params.status === 'number') {
      return false;
    }

    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('rate limit') ||
      message.includes('temporarily') ||
      message.includes('try again') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('eai_again') ||
      message.includes('connection') ||
      message.includes('connect')
    );
  }

  private hasRecoverableChannelSuggestionDeliveryFailure(
    failures: ChannelSuggestionAdminDeliveryFailure[],
  ): boolean {
    return failures.some((failure) => !failure.terminal && failure.recoverable);
  }

  private buildChannelSuggestionAdminReviewButtons(suggestionId: string): MaxMessageButton[][] {
    return [
      [
        {
          type: 'callback',
          text: '📰 В публикацию',
          payload: this.buildPrivateControlCallbackPayload(
            'suggestion_review_publish',
            suggestionId,
          ),
          intent: 'positive',
        },
        {
          type: 'callback',
          text: '✖️ Отклонить',
          payload: this.buildPrivateControlCallbackPayload(
            'suggestion_review_cancel',
            suggestionId,
          ),
          intent: 'negative',
        },
      ],
    ];
  }

  private buildPublisherSuggestionAdminReviewButtons(suggestionId: string): MaxMessageButton[][] {
    return [
      [
        {
          type: 'callback',
          text: '📰 В публикацию',
          payload: buildPublisherSuggestionAdminReviewCallbackPayload('publish', suggestionId),
          intent: 'positive',
        },
        {
          type: 'callback',
          text: '✖️ Отклонить',
          payload: buildPublisherSuggestionAdminReviewCallbackPayload('cancel', suggestionId),
          intent: 'negative',
        },
      ],
    ];
  }

  private buildChannelSuggestionAdminReviewedButtons(
    publishedUrl: string | null,
  ): MaxMessageButton[][] {
    const normalizedUrl = this.normalizeMaxEntityLink(publishedUrl);
    if (!normalizedUrl) {
      return [];
    }

    return [
      [
        {
          type: 'link',
          text: 'Открыть пост',
          url: normalizedUrl,
        },
      ],
    ];
  }

  private buildPrivateControlCallbackPayload(action: string, ...args: string[]): string {
    const normalizedArgs = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
    return [PRIVATE_CONTROL_CALLBACK_PREFIX, action, ...normalizedArgs].join('|');
  }

  private async syncChannelSuggestionAdminReviewMessages(
    suggestionId: string,
    chatId: string,
    payload: Record<string, unknown>,
    requiredBotId?: string | null,
    throwOnRetryableFailure = false,
    publishedPresentation: 'confirmed' | 'publication_created' = 'confirmed',
  ): Promise<number> {
    const exactBotId = this.readTrimmedString(requiredBotId);
    const ledgerRows = await this.readChannelSuggestionAdminDeliveryLedgerRows(
      suggestionId,
      exactBotId ? `publisher:${exactBotId}` : undefined,
    );
    const ledgerDeliveries = ledgerRows
      .map((row) => this.mapChannelSuggestionAdminDeliveryRowToLegacyDelivery(row))
      .filter((entry): entry is ChannelSuggestionAdminDelivery => entry !== null);
    const deliveries =
      ledgerDeliveries.length > 0
        ? ledgerDeliveries
        : this.readChannelSuggestionDeliveries(payload.deliveries);
    const scopedDeliveries = exactBotId
      ? deliveries.filter((delivery) => delivery.botId === exactBotId)
      : deliveries;
    if (scopedDeliveries.length === 0) {
      return 0;
    }

    const channelTitle = await this.resolveChannelTitle(chatId);
    const actorUserId = this.readTrimmedString(payload.actorUserId) ?? '';
    const authorAttribution: ChannelSuggestionAuthorAttribution = {
      userId: actorUserId,
      displayName: this.readTrimmedString(payload.authorDisplayName),
      mentionDisplayName: this.readTrimmedString(payload.authorMentionDisplayName),
      username: this.readTrimmedString(payload.authorUsername),
      profileUrl:
        this.normalizeMaxProfileUrl(this.readTrimmedString(payload.authorProfileUrl)) ?? null,
    };
    const reviewedBy = this.readTrimmedString(payload.reviewedByDisplayName);
    const storedReviewStatus = this.readLowerString(payload.reviewStatus);
    const reviewStatus =
      storedReviewStatus === 'published'
        ? 'published'
        : storedReviewStatus === 'drafted'
          ? 'drafted'
          : 'cancelled';
    const publishedUrl = this.readTrimmedString(payload.publishedUrl);
    const buttons =
      reviewStatus === 'published'
        ? this.buildChannelSuggestionAdminReviewedButtons(publishedUrl)
        : [];
    const textMarkup = this.readChannelSuggestionTextMarkup(payload.textMarkup);
    const messagePayload = buildChannelSuggestionAdminMessagePayloadValue({
      status: reviewStatus,
      publishedPresentation,
      channelTitle,
      authorAttribution,
      text: this.readRawString(payload.text) ?? '',
      textFormat: this.normalizeBroadcastTextFormat(
        this.readTrimmedString(payload.textFormat) ?? 'plain',
      ),
      textMarkup,
      reviewedBy,
      publishedUrl,
    });

    const retryableErrors: unknown[] = [];
    for (const delivery of scopedDeliveries) {
      try {
        const deliveryBotId = this.resolvePrivateDeliveryBotId(delivery.botId);
        if (deliveryBotId) {
          await this.maxClient.editMessageInlineKeyboard(
            delivery.privateChatId,
            delivery.messageId,
            messagePayload.text,
            {
              buttons,
              textFormat: messagePayload.textFormat,
            },
            { botId: deliveryBotId },
          );
        } else {
          await this.maxClient.editMessageInlineKeyboard(
            delivery.privateChatId,
            delivery.messageId,
            messagePayload.text,
            {
              buttons,
              textFormat: messagePayload.textFormat,
            },
          );
        }
      } catch (error: unknown) {
        if (
          throwOnRetryableFailure &&
          this.isRecoverableChannelSuggestionDeliveryFailureData({
            status: extractMaxErrorStatus(error),
            code: extractMaxErrorCode(error),
            message: extractMaxErrorMessage(error),
          })
        ) {
          retryableErrors.push(error);
        }
        this.logger.warn(
          {
            chatId,
            adminUserId: delivery.adminUserId,
            privateChatId: delivery.privateChatId,
            messageId: delivery.messageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to sync reviewed suggestion message in admin private chat',
        );
      }
    }
    if (retryableErrors.length > 0) {
      throw retryableErrors[0];
    }
    return scopedDeliveries.length;
  }

  private readChannelSuggestionDeliveries(value: unknown): ChannelSuggestionAdminDelivery[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }

        const row = item as Record<string, unknown>;
        const adminUserId = this.readTrimmedString(row.adminUserId);
        const privateChatId = this.readTrimmedString(row.privateChatId);
        const messageId = this.readTrimmedString(row.messageId);
        const botId = this.resolvePrivateDeliveryBotId(this.readTrimmedString(row.botId));
        if (!adminUserId || !privateChatId || !messageId) {
          return null;
        }

        return {
          adminUserId,
          privateChatId,
          messageId,
          ...(botId ? { botId } : {}),
        };
      })
      .filter((entry): entry is ChannelSuggestionAdminDelivery => entry !== null);
  }

  private readChannelSuggestionDeliveryFailures(
    value: unknown,
  ): ChannelSuggestionAdminDeliveryFailure[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }

        const row = item as Record<string, unknown>;
        const adminUserId = this.readTrimmedString(row.adminUserId);
        if (!adminUserId) {
          return null;
        }

        const privateChatId = this.readTrimmedString(row.privateChatId);
        const botId = this.resolvePrivateDeliveryBotId(this.readTrimmedString(row.botId));
        const status = this.readNullableStatusCode(row.status);
        const code = this.readLowerString(row.code);
        const message = this.readRawString(row.message)?.trim() ?? '';
        const terminal = row.terminal === true || this.readLowerString(row.terminal) === 'true';
        const persistedRecoverable = typeof row.recoverable === 'boolean' ? row.recoverable : null;
        const recoverable =
          persistedRecoverable ??
          (!terminal &&
            this.isRecoverableChannelSuggestionDeliveryFailureData({
              status,
              code,
              message,
            }));

        return {
          adminUserId,
          privateChatId,
          ...(botId ? { botId } : {}),
          status,
          code,
          terminal,
          recoverable,
          message,
        };
      })
      .filter((entry): entry is ChannelSuggestionAdminDeliveryFailure => entry !== null);
  }

  private readNullableStatusCode(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? null : parsed;
    }

    return null;
  }

  private escapeMarkdown(value: string): string {
    return value.replace(/([\\_*[\]()`])/g, '\\$1');
  }

  private escapeMarkdownPlainText(value: string): string {
    return escapeMarkdownPlainText(value);
  }

  private parseChannelSuggestionFromBotPayload(body: unknown): ChannelSuggestionFromBotPayload {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Некорректная предложка.');
    }

    const row = body as Record<string, unknown>;
    const token = this.readTrimmedString(row.token);
    if (!token || token.length < 16 || token.length > 256) {
      throw new BadRequestException('Неверный токен предложки.');
    }

    const text = this.readRawString(row.text) ?? '';
    if (text.length > 2_000) {
      throw new BadRequestException('Текст предложки слишком длинный.');
    }

    const rawImages = Array.isArray(row.images) ? row.images : [];
    if (rawImages.length > MAX_CHANNEL_DIALOG_SUGGEST_IMAGES) {
      throw new BadRequestException(
        `В одной предложке можно отправить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фото.`,
      );
    }

    const images = this.readChannelSuggestionImageAssets(row.images);
    const textFormat = this.normalizeBroadcastTextFormat(
      this.readTrimmedString(row.textFormat) ?? 'plain',
    );
    const textMarkup = this.readChannelSuggestionTextMarkup(row.textMarkup);
    const imageBase64 = this.readTrimmedString(row.imageBase64);
    const imageMimeType = this.readTrimmedString(row.imageMimeType);
    const imageFileName = this.readTrimmedString(row.imageFileName);
    const mediaType = this.readChannelSuggestionMediaType(row.mediaType);
    const mediaPayload = this.readObjectPayloadOrNull(row.mediaPayload);
    const mediaMimeType = this.readTrimmedString(row.mediaMimeType);
    const mediaFileName = this.readTrimmedString(row.mediaFileName);

    if (!text.trim() && images.length === 0 && !imageBase64 && !mediaPayload) {
      throw new BadRequestException('Пришлите текст, фото, видео или подпись к медиа.');
    }

    if (images.length > 0 && mediaType === 'video') {
      throw new BadRequestException(
        'В одной предложке можно отправить либо фото, либо одно видео.',
      );
    }

    if (imageBase64 && (!imageMimeType || !imageMimeType.toLowerCase().startsWith('image/'))) {
      throw new BadRequestException('Фото предложки передано в неверном формате.');
    }

    if (
      images.some(
        (image) =>
          image.mimeType &&
          image.mimeType.trim().length > 0 &&
          !image.mimeType.toLowerCase().startsWith('image/'),
      )
    ) {
      throw new BadRequestException('Фото предложки передано в неверном формате.');
    }

    if ((mediaType && !mediaPayload) || (!mediaType && mediaPayload)) {
      throw new BadRequestException('Медиа предложки передано в неполном формате.');
    }

    if (
      mediaType === 'image' &&
      mediaMimeType &&
      !mediaMimeType.toLowerCase().startsWith('image/')
    ) {
      throw new BadRequestException('Фото предложки передано в неверном формате.');
    }

    if (
      mediaType === 'video' &&
      mediaMimeType &&
      !mediaMimeType.toLowerCase().startsWith('video/')
    ) {
      throw new BadRequestException('Видео предложки передано в неверном формате.');
    }

    return {
      token,
      images,
      text,
      textFormat,
      textMarkup,
      imageBase64,
      imageMimeType,
      imageFileName,
      mediaType,
      mediaPayload,
      mediaMimeType,
      mediaFileName,
    };
  }

  private resolveTrustedChannelSuggestionMediaBotId(
    suggestion: Pick<ChannelSuggestionFromBotPayload, 'images' | 'mediaPayload'>,
    trustedMediaBotId?: string | null,
  ): string | null {
    if (
      !hasChannelSuggestionBotScopedMediaToken(
        { mediaPayload: suggestion.mediaPayload },
        suggestion.images,
      )
    ) {
      return null;
    }

    const normalizedBotId = this.readTrimmedString(trustedMediaBotId);
    if (!normalizedBotId) {
      return null;
    }
    if (!this.maxBotRegistry) {
      return normalizedBotId;
    }
    return this.maxBotRegistry.getBotById(normalizedBotId)?.id ?? null;
  }

  private canBuildChannelDialogImagePreview(mimeType: string | null | undefined): boolean {
    return channelDialogValues.canBuildChannelDialogImagePreview(mimeType);
  }

  private normalizeMaxUploadImageMimeType(mimeType: string | null | undefined): string {
    const normalized = mimeType?.trim().toLowerCase() ?? '';
    if (normalized === 'image/jpg' || normalized === 'image/pjpeg') {
      return 'image/jpeg';
    }
    if (normalized === 'image/x-png') {
      return 'image/png';
    }
    return normalized;
  }

  private isSupportedMaxUploadImageMimeType(mimeType: string | null | undefined): boolean {
    const normalized = this.normalizeMaxUploadImageMimeType(mimeType);
    return (
      normalized === 'image/bmp' ||
      normalized === 'image/gif' ||
      normalized === 'image/heic' ||
      normalized === 'image/jpeg' ||
      normalized === 'image/png' ||
      normalized === 'image/tiff'
    );
  }

  private normalizeChannelDialogCommentInputAttachments(
    attachments: Array<{
      type: 'image' | 'file';
      base64: string;
      mimeType: string;
      fileName: string;
      width?: number;
      height?: number;
    }>,
  ): ChannelDialogAttachmentAsset[] {
    return attachments
      .map((attachment) => {
        const mimeType = attachment.mimeType.trim();
        const fileName = attachment.fileName.trim();
        const kind =
          this.resolveChannelDialogAttachmentKind(attachment.type, mimeType, fileName) ??
          attachment.type;

        return {
          kind,
          base64: attachment.base64.trim(),
          mimeType,
          fileName,
          width: this.toSafeInteger(attachment.width),
          height: this.toSafeInteger(attachment.height),
        };
      })
      .filter((attachment) => attachment.base64)
      .slice(0, MAX_CHANNEL_DIALOG_ATTACHMENTS);
  }

  private async uploadChannelDialogCommentAttachments(
    chatId: string,
    attachments: ChannelDialogAttachmentAsset[],
  ): Promise<ChannelDialogAttachmentAsset[]> {
    if (attachments.length === 0) {
      return [];
    }

    const resolvedBotId = await this.resolveManualActionBotAssignment(
      chatId,
      ChatEntityType.CHANNEL,
    );
    const uploaded: ChannelDialogAttachmentAsset[] = [];

    for (const attachment of attachments) {
      const normalized = await this.uploadChannelDialogCommentAttachment(attachment, resolvedBotId);
      if (normalized) {
        uploaded.push(normalized);
      }
    }

    return uploaded;
  }

  private async uploadChannelDialogCommentAttachment(
    attachment: ChannelDialogAttachmentAsset,
    botId?: string,
  ): Promise<ChannelDialogAttachmentAsset | null> {
    const base64 = attachment.base64?.trim() ?? '';
    if (!base64) {
      return null;
    }

    const kind =
      this.resolveChannelDialogAttachmentKind(
        attachment.kind,
        attachment.mimeType,
        attachment.fileName,
      ) ?? attachment.kind;
    const mimeType =
      kind === 'image'
        ? this.normalizeMaxUploadImageMimeType(attachment.mimeType) || 'image/jpeg'
        : attachment.mimeType?.trim().toLowerCase() || 'application/octet-stream';
    if (kind === 'image' && !mimeType.startsWith('image/')) {
      throw new BadRequestException('Фото комментария передано в неверном формате.');
    }
    if (kind === 'image' && !this.isSupportedMaxUploadImageMimeType(mimeType)) {
      throw new BadRequestException(
        'MAX пока не принимает этот формат фото. Используйте JPG, PNG, GIF, TIFF, BMP или HEIC.',
      );
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      throw new BadRequestException(
        kind === 'image'
          ? 'Не удалось прочитать фото комментария.'
          : 'Не удалось прочитать файл комментария.',
      );
    }

    if (buffer.length === 0) {
      throw new BadRequestException(
        kind === 'image'
          ? 'Фото комментария оказалось пустым.'
          : 'Файл комментария оказался пустым.',
      );
    }

    const fileName =
      this.readTrimmedString(attachment.fileName) ||
      (kind === 'image'
        ? this.resolveBroadcastImageFileName('', mimeType)
        : 'comment-attachment.bin');

    try {
      const payload =
        kind === 'image'
          ? botId
            ? await this.maxClient.uploadImage(buffer, fileName, mimeType, { botId })
            : await this.maxClient.uploadImage(buffer, fileName, mimeType)
          : botId
            ? await this.maxClient.uploadFile(buffer, fileName, mimeType, { botId })
            : await this.maxClient.uploadFile(buffer, fileName, mimeType);

      return {
        kind,
        payload,
        mimeType,
        fileName,
        previewBase64:
          kind === 'image' &&
          this.canBuildChannelDialogImagePreview(mimeType) &&
          !this.readTrimmedString(payload.url)
            ? base64
            : undefined,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          kind,
          mimeType,
          fileName,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to upload channel dialog attachment',
      );
      throw new BadRequestException(
        kind === 'image'
          ? 'Не удалось загрузить фото комментария.'
          : 'Не удалось загрузить файл комментария.',
      );
    }
  }

  private resolveChannelDialogAttachmentKind(
    kind: unknown,
    mimeType?: string | null,
    fileName?: string | null,
  ): 'image' | 'file' | null {
    return channelDialogValues.resolveChannelDialogAttachmentKind(kind, mimeType, fileName);
  }

  private isChannelDialogImageLikeAttachment(
    mimeType?: string | null,
    fileName?: string | null,
  ): boolean {
    return channelDialogValues.isChannelDialogImageLikeAttachment(mimeType, fileName);
  }

  private isChannelDialogImageMimeType(value?: string | null): boolean {
    return channelDialogValues.isChannelDialogImageMimeType(value);
  }

  private isLikelyImageFileName(value?: string | null): boolean {
    return channelDialogValues.isLikelyImageFileName(value);
  }

  private async uploadChannelSuggestionImage(
    suggestion: {
      imageBase64?: string | null;
      imageMimeType?: string | null;
      imageFileName?: string | null;
    },
    botId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    const imageBase64 = suggestion.imageBase64?.trim() ?? '';
    if (!imageBase64) {
      return undefined;
    }

    const mimeType = suggestion.imageMimeType?.trim().toLowerCase() || 'image/jpeg';
    if (!mimeType.startsWith('image/')) {
      throw new BadRequestException('Фото предложки передано в неверном формате.');
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(imageBase64, 'base64');
    } catch {
      throw new BadRequestException('Не удалось прочитать фото предложки.');
    }

    if (imageBuffer.length === 0) {
      throw new BadRequestException('Фото предложки оказалось пустым.');
    }

    const fileName =
      this.readTrimmedString(suggestion.imageFileName) ||
      this.resolveBroadcastImageFileName('', mimeType);

    try {
      return botId
        ? await this.maxClient.uploadImage(imageBuffer, fileName, mimeType, {
            botId,
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
            timeoutMs: CHANNEL_SUGGESTION_UPLOAD_TIMEOUT_MS,
          })
        : await this.maxClient.uploadImage(imageBuffer, fileName, mimeType, {
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
            timeoutMs: CHANNEL_SUGGESTION_UPLOAD_TIMEOUT_MS,
          });
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          mimeType,
        },
        'Failed to upload channel suggestion image',
      );
      throw error;
    }
  }

  private async resolveChannelSuggestionAttachments(
    suggestion: {
      images?: ChannelSuggestionImageAsset[] | null;
      imageBase64?: string | null;
      imageMimeType?: string | null;
      imageFileName?: string | null;
      mediaType?: 'image' | 'video' | null;
      mediaPayload?: Record<string, unknown> | null;
      mediaMimeType?: string | null;
      mediaFileName?: string | null;
    },
    botId?: string,
  ): Promise<{
    imagePayload?: Record<string, unknown>;
    attachments?: MaxAttachmentPayload[];
  }> {
    const video = suggestion.images?.find((asset) => asset.type === 'video');
    if (video) {
      if (suggestion.images?.length !== 1)
        throw new BadRequestException('Фото и видео отправляются отдельными предложениями.');
      return uploadChannelSuggestionVideo(video, this.maxClient, botId);
    }
    const normalizedImages = this.normalizeChannelSuggestionImages({
      images: suggestion.images,
      imageBase64: suggestion.imageBase64,
      imageMimeType: suggestion.imageMimeType,
      imageFileName: suggestion.imageFileName,
      mediaType: suggestion.mediaType,
      mediaPayload: suggestion.mediaPayload,
      mediaMimeType: suggestion.mediaMimeType,
      mediaFileName: suggestion.mediaFileName,
    });

    if (normalizedImages.length === 1) {
      const [image] = normalizedImages;
      const payload =
        image.payload && Object.keys(image.payload).length > 0
          ? image.payload
          : await this.uploadChannelSuggestionImage(
              {
                imageBase64: image.base64 ?? null,
                imageMimeType: image.mimeType ?? null,
                imageFileName: image.fileName ?? null,
              },
              botId,
            );

      return payload ? { imagePayload: payload } : {};
    }

    if (normalizedImages.length > 1) {
      const attachments: MaxAttachmentPayload[] = [];

      for (const image of normalizedImages) {
        const payload =
          image.payload && Object.keys(image.payload).length > 0
            ? image.payload
            : await this.uploadChannelSuggestionImage(
                {
                  imageBase64: image.base64 ?? null,
                  imageMimeType: image.mimeType ?? null,
                  imageFileName: image.fileName ?? null,
                },
                botId,
              );

        if (!payload) {
          continue;
        }

        attachments.push({
          type: 'image',
          payload,
        });
      }

      return attachments.length > 0 ? { attachments } : {};
    }

    if (suggestion.mediaType && suggestion.mediaPayload) {
      return suggestion.mediaType === 'image'
        ? {
            imagePayload: suggestion.mediaPayload,
          }
        : {
            attachments: [
              {
                type: suggestion.mediaType,
                payload: suggestion.mediaPayload,
              },
            ],
          };
    }

    const uploadedImagePayload = await this.uploadChannelSuggestionImage(
      {
        imageBase64: suggestion.imageBase64,
        imageMimeType: suggestion.imageMimeType,
        imageFileName: suggestion.imageFileName,
      },
      botId,
    );

    return uploadedImagePayload ? { imagePayload: uploadedImagePayload } : {};
  }

  private async buildChannelSuggestionMessageOptions(
    suggestion: {
      images?: ChannelSuggestionImageAsset[] | null;
      imageBase64?: string | null;
      imageMimeType?: string | null;
      imageFileName?: string | null;
      mediaType?: 'image' | 'video' | null;
      mediaPayload?: Record<string, unknown> | null;
      mediaMimeType?: string | null;
      mediaFileName?: string | null;
    },
    buttons: MaxMessageButton[][],
    botId?: string,
  ): Promise<
    Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
  > {
    const media = await this.resolveChannelSuggestionAttachments(suggestion, botId);
    return {
      buttons,
      ...(media.imagePayload ? { imagePayload: media.imagePayload } : {}),
      ...(media.attachments?.length ? { attachments: media.attachments } : {}),
      textFormat: 'markdown',
    };
  }

  private async sendChannelSuggestionAdminMessageWithRetry(params: {
    privateChatId: string;
    message: string;
    options: Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>;
    botId?: string;
    beforeSend: () => Promise<void>;
    onAttemptStart: () => Promise<void>;
  }) {
    let lastError: unknown = null;
    const attempts =
      Math.max(
        resolveManagedBroadcastAttachmentRetryCount(params.options),
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
      ) + 1;

    for (let attempt = 1; attempt <= attempts; ) {
      try {
        await params.onAttemptStart();
        return await this.maxClient.sendMessageImmediateWithId(
          params.privateChatId,
          params.message,
          {
            ...params.options,
            beforeSend: params.beforeSend,
          },
          {
            trafficClass: 'background',
            sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
            timeoutMs: CHANNEL_SUGGESTION_SEND_TIMEOUT_MS,
            ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
            ...(params.botId ? { botId: params.botId } : {}),
          },
        );
      } catch (error: unknown) {
        lastError = error;
        const retryDelayMs = this.resolveManagedBroadcastSendRetryDelayMs(
          error,
          attempt,
          params.options,
        );
        if (retryDelayMs === null) {
          throw error;
        }
        await params.onAttemptStart();
        await this.sleep(retryDelayMs);
        attempt += 1;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('Suggestion admin delivery failed without error details.');
  }

  private readChannelSuggestionMediaType(value: unknown): 'image' | 'video' | null {
    return channelDialogValues.readChannelSuggestionMediaType(value);
  }

  private async findLatestPrivateChatIdForUser(
    userId: string,
    botId?: string | null,
  ): Promise<string | null> {
    const resolvedBotId = this.maxBotRegistry?.getBotById(botId)?.id ?? botId?.trim() ?? null;
    if (!resolvedBotId) {
      return null;
    }
    const routes = await this.findLatestPrivateChatRoutesForUser(userId, [resolvedBotId]);
    return routes[0]?.privateChatId ?? null;
  }

  private async findLatestPrivateChatRoutesForUser(
    userId: string,
    botIds: string[],
  ): Promise<ChannelSuggestionPrivateDeliveryRoute[]> {
    const normalizedUserId = this.readTrimmedString(userId);
    const normalizedBotIds = Array.from(
      new Set(
        botIds
          .map((botId) => this.readTrimmedString(botId))
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    if (!normalizedUserId || normalizedBotIds.length === 0) {
      return [];
    }

    const lookbackFrom = new Date(Date.now() - MANAGED_ENTITIES_LOCAL_ACTIVITY_LOOKBACK_MS);
    const routes: ChannelSuggestionPrivateDeliveryRoute[] = [];
    for (const botId of normalizedBotIds) {
      const rows = await this.prisma.$queryRaw<Array<{ recipient_chat_id: string | null }>>(
        Prisma.sql`
          SELECT
            NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') AS recipient_chat_id
          FROM webhook_events
          WHERE normalized_payload->'message'->>'senderId' = ${normalizedUserId}
            AND created_at >= ${lookbackFrom}
            AND bot_id = ${botId}
            AND NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), '') ~ '^[1-9][0-9]*$'
            AND normalized_payload->>'type' IN ('message_created', 'message_callback', 'bot_started')
          ORDER BY created_at DESC
          LIMIT 1
        `,
      );
      const privateChatId = this.readTrimmedString(rows[0]?.recipient_chat_id);
      if (privateChatId) {
        routes.push({ botId, privateChatId });
      }
    }
    return routes;
  }

  private async resolvePrivateDialogChatId(
    user: AuthUser,
    botId?: string | null,
  ): Promise<string | null> {
    const resolvedBotId =
      this.resolvePrivateDeliveryBotId(botId) ??
      this.maxBotRegistry?.getBotById(botId)?.id ??
      botId?.trim() ??
      null;
    const currentChatId = user.chatId?.trim() ?? '';
    const activeContextBotId = this.maxBotLinkService?.getContextOrDefaultBotId?.() ?? null;
    if (
      currentChatId &&
      /^[1-9][0-9]*$/u.test(currentChatId) &&
      (!resolvedBotId || !activeContextBotId || activeContextBotId === resolvedBotId)
    ) {
      return currentChatId;
    }

    return this.findLatestPrivateChatIdForUser(user.userId, resolvedBotId);
  }

  private async sendRulesPublishedPrivateConfirmation(
    user: AuthUser,
    publishedUrl: string | null,
    operation: 'created' | 'updated' = 'created',
  ): Promise<void> {
    const privateDeliveryBotId = this.resolvePrivateDeliveryBotId();
    const privateChatId = await this.resolvePrivateDialogChatId(user, privateDeliveryBotId);
    if (!privateChatId) {
      return;
    }

    const confirmation =
      operation === 'updated'
        ? '✅ Правила обновлены в прежнем сообщении. Новое сообщение в группу не отправлялось.'
        : '✅ Правила опубликованы.';
    const message = publishedUrl ? `${confirmation}\n${publishedUrl}` : confirmation;

    try {
      await this.maxClient.sendMessage(privateChatId, message, undefined, {
        immediate: true,
        ...(privateDeliveryBotId ? { botId: privateDeliveryBotId } : {}),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId: user.userId,
          privateChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send private confirmation after rules publish',
      );
    }
  }

  private async resolveChannelTitle(
    chatId: string,
    options: Parameters<MaxClientService['getChatTitle']>[1] = {},
  ): Promise<string> {
    const local = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { title: true },
    });
    if (local?.title?.trim()) {
      return local.title.trim();
    }

    const remote = await this.maxClient.getChatTitle(chatId, options);
    if (remote?.trim()) {
      return remote.trim();
    }

    return `Канал ${chatId}`;
  }

  private buildChannelSuggestionStartPayload(
    chatId: string,
    threadId: string,
    botId?: string | null,
  ): string {
    return this.dialogLinkHelper.buildChannelSuggestionStartPayload(chatId, threadId, botId);
  }

  private buildEntityDialogToken(
    entityType: ManagedEntityType,
    chatId: string,
    type: ChannelDialogType,
    threadId?: string | null,
  ): string {
    return this.dialogLinkHelper.buildEntityDialogToken(entityType, chatId, type, threadId);
  }

  private resolveChannelDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.dialogLinkHelper.resolveChannelDialogThreadId(chatId, type, token);
  }

  private resolveChatDialogThreadId(
    chatId: string,
    type: ChannelDialogType,
    token: string | null | undefined,
  ): string | null {
    return this.dialogLinkHelper.resolveChatDialogThreadId(chatId, type, token);
  }

  private resolvePrivateDeliveryBotId(botId?: string | null): string | undefined {
    const explicitBotId = this.maxBotRegistry?.getBotById(botId)?.id ?? botId?.trim() ?? undefined;
    if (explicitBotId) {
      return explicitBotId;
    }

    return (
      this.maxBotLinkService?.getContextOrDefaultBotId?.() ??
      this.maxBotRegistry?.getDefaultBot?.().id ??
      this.ownBotUserId ??
      undefined
    );
  }

  private buildResolvedBotAssignmentData(resolvedBotId?: string | null): {
    botId?: string;
    primaryBotId?: string;
  } {
    const normalizedBotId =
      this.maxBotRegistry?.getBotById(resolvedBotId)?.id ??
      (typeof resolvedBotId === 'string' && resolvedBotId.trim().length > 0
        ? resolvedBotId.trim()
        : null);
    if (!normalizedBotId) {
      return {};
    }

    return {
      botId: normalizedBotId,
      primaryBotId: normalizedBotId,
    };
  }

  private async resolveUnifiedBotRoute(request: MaxBotRouteRequest): Promise<MaxBotRoute | null> {
    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
      resolveBotRoutes?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    if (
      request.purpose === 'moderation_action' &&
      typeof routeResolver?.resolveBotRoutes === 'function'
    ) {
      return routeResolver.resolveBotRoutes(request);
    }

    if (typeof routeResolver?.resolveBotRoute === 'function') {
      return routeResolver.resolveBotRoute(request);
    }

    return null;
  }

  private async resolveBotAssignmentRouteAware(chatId: string): Promise<{
    botId: string | undefined;
    routeResolved: boolean;
  }> {
    const route = await this.resolveUnifiedBotRoute({
      purpose: 'read',
      chatId,
    });
    if (route) {
      return { botId: route.botId ?? undefined, routeResolved: true };
    }

    const legacyBotId =
      (await this.maxBotLinkService?.resolveBotIdForRead?.({ chatId })) ??
      (await this.maxBotLinkService?.resolveBotId?.({ chatId })) ??
      undefined;
    return { botId: legacyBotId, routeResolved: false };
  }

  private async resolveBotAssignment(chatId: string): Promise<string | undefined> {
    return (await this.resolveBotAssignmentRouteAware(chatId)).botId;
  }

  private async resolveChatBotIdForRead(chatId: string): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    const routed = await this.resolveBotAssignmentRouteAware(normalizedChatId);
    if (routed.botId) {
      return routed.botId;
    }
    if (routed.routeResolved) {
      return undefined;
    }

    const persisted = await this.prisma.chat.findUnique({
      where: { id: normalizedChatId },
      select: { primaryBotId: true, botId: true },
    });
    return (
      this.maxBotRegistry?.getBotById(persisted?.primaryBotId ?? persisted?.botId ?? null)?.id ??
      this.readTrimmedString(persisted?.primaryBotId ?? persisted?.botId) ??
      undefined
    );
  }

  private resolveManualModerationBotAction(action: string): ManualModerationBotAction | null {
    if (action === 'MUTE') {
      return 'delete_message';
    }
    if (action === 'BAN' || action === 'UNBAN') {
      return 'moderate_member';
    }
    return null;
  }

  private normalizeManualModerationBotId(botId: unknown): string | null {
    const normalizedBotId = this.readTrimmedString(botId);
    if (!normalizedBotId) {
      return null;
    }

    return this.maxBotRegistry?.getBotById(normalizedBotId)?.id ?? normalizedBotId;
  }

  private appendManualModerationBotCandidate(
    target: string[],
    seen: Set<string>,
    botId: unknown,
  ): void {
    const normalizedBotId = this.normalizeManualModerationBotId(botId);
    if (!normalizedBotId || seen.has(normalizedBotId)) {
      return;
    }
    seen.add(normalizedBotId);
    target.push(normalizedBotId);
  }

  private async recordManualActionBotAccessProbe(params: {
    chatId: string;
    botId: string;
    access: MaxChatMemberAccess;
    checkedAt: Date;
    source: string;
  }): Promise<boolean> {
    const linkService = this.maxBotLinkService as
      | (MaxBotLinkService & {
          recordBotAccessProbe?: MaxBotLinkService['recordBotAccessProbe'];
        })
      | undefined;
    if (typeof linkService?.recordBotAccessProbe !== 'function') {
      return true;
    }

    return linkService.recordBotAccessProbe({
      chatId: params.chatId,
      botId: params.botId,
      access: params.access,
      source: params.source,
      checkedAt: params.checkedAt,
      allowMembershipRecovery: true,
    });
  }

  private async isManualActionBotInAuthoritativeRoute(
    request: MaxBotRouteRequest,
    botId: string,
  ): Promise<boolean> {
    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (routeRequest: MaxBotRouteRequest) => Promise<MaxBotRoute>;
      resolveBotRoutes?: (routeRequest: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    const hasResolver =
      typeof routeResolver?.resolveBotRoute === 'function' ||
      (request.purpose === 'moderation_action' &&
        typeof routeResolver?.resolveBotRoutes === 'function');
    if (!hasResolver) {
      return true;
    }

    const route = await this.resolveUnifiedBotRoute(request);
    if (!route) {
      return false;
    }
    const normalizedBotId = this.normalizeManualModerationBotId(botId);
    return [route.botId, ...route.candidateBotIds].some(
      (candidateBotId) => this.normalizeManualModerationBotId(candidateBotId) === normalizedBotId,
    );
  }

  private async resolveManualModerationActionBotAssignment(
    chatId: string,
    action: ManualModerationBotAction | null,
    options: ResolveManualModerationActionBotAssignmentOptions = {},
  ): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    if (!action) {
      return this.resolveManualActionBotAssignment(normalizedChatId);
    }

    const preferredBotId = this.normalizeManualModerationBotId(options.preferredBotId);
    const entityType = options.entityType ?? ChatEntityType.CHAT;
    const maxClientWithAccess = this.maxClient as MaxClientService & {
      getCurrentChatMemberAccess?: MaxClientService['getCurrentChatMemberAccess'];
    };
    if (preferredBotId) {
      if (typeof maxClientWithAccess.getCurrentChatMemberAccess !== 'function') {
        if (action !== 'delete_message') {
          return preferredBotId;
        }
      } else {
        try {
          const probeStartedAt = new Date();
          const access = await maxClientWithAccess.getCurrentChatMemberAccess(normalizedChatId, {
            trafficClass: 'critical',
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            botId: preferredBotId,
            bypassCache: true,
          });
          const persisted = await this.recordManualActionBotAccessProbe({
            chatId: normalizedChatId,
            botId: preferredBotId,
            access,
            checkedAt: probeStartedAt,
            source: 'admin_manual_moderation_preferred',
          });
          if (
            persisted &&
            this.hasManualModerationBotActionAccess(access, action, entityType) &&
            (await this.isManualActionBotInAuthoritativeRoute(
              {
                purpose: 'moderation_action',
                chatId: normalizedChatId,
                action,
                fallbackToPrimary: true,
              },
              preferredBotId,
            ))
          ) {
            return preferredBotId;
          }
        } catch (error: unknown) {
          if (isBotAdminLookupDeniedError(error)) {
            // Try the regular route below; another runtime bot may still be able to act.
          } else {
            this.throwManualModerationTransientMaxError(error);
            this.logger.debug(
              {
                chatId: normalizedChatId,
                action,
                botId: preferredBotId,
                err: error instanceof Error ? error.message : String(error),
              },
              'Failed to verify preferred manual moderation bot candidate',
            );
          }
        }
      }
    }

    const candidateBotIds: string[] = [];
    const seenBotIds = new Set<string>();
    const routeCandidateBotIds = new Set<string>();
    const membershipCandidateBotIds = new Set<string>();
    const registryCandidateBotIds = new Set<string>();

    try {
      const route = await this.resolveUnifiedBotRoute({
        purpose: 'moderation_action',
        chatId: normalizedChatId,
        action,
        fallbackToPrimary: true,
      });
      for (const candidateBotId of route?.candidateBotIds ?? []) {
        const normalizedCandidateBotId = this.normalizeManualModerationBotId(candidateBotId);
        this.appendManualModerationBotCandidate(
          candidateBotIds,
          seenBotIds,
          normalizedCandidateBotId,
        );
        if (normalizedCandidateBotId) {
          routeCandidateBotIds.add(normalizedCandidateBotId);
        }
      }
      const normalizedRouteBotId = this.normalizeManualModerationBotId(route?.botId);
      this.appendManualModerationBotCandidate(candidateBotIds, seenBotIds, normalizedRouteBotId);
      if (normalizedRouteBotId) {
        routeCandidateBotIds.add(normalizedRouteBotId);
      }
    } catch (error: unknown) {
      this.throwManualModerationTransientMaxError(error);
      this.logger.debug(
        {
          chatId: normalizedChatId,
          action,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve action-specific bot route for manual moderation',
      );
    }

    try {
      for (const candidateBotId of await this.resolveCandidateBotIdsForChat(normalizedChatId)) {
        const normalizedCandidateBotId = this.normalizeManualModerationBotId(candidateBotId);
        this.appendManualModerationBotCandidate(
          candidateBotIds,
          seenBotIds,
          normalizedCandidateBotId,
        );
        if (normalizedCandidateBotId) {
          membershipCandidateBotIds.add(normalizedCandidateBotId);
        }
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          action,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve chat bot candidates for manual moderation action',
      );
    }

    for (const bot of this.maxBotRegistry?.getActionableBots() ?? []) {
      const normalizedCandidateBotId = this.normalizeManualModerationBotId(bot.id);
      this.appendManualModerationBotCandidate(
        candidateBotIds,
        seenBotIds,
        normalizedCandidateBotId,
      );
      if (normalizedCandidateBotId) {
        registryCandidateBotIds.add(normalizedCandidateBotId);
      }
    }

    if (candidateBotIds.length === 0 && !this.maxBotRegistry) {
      return this.resolveLegacyManualModerationActionBotAssignment(
        normalizedChatId,
        action,
        entityType,
      );
    }

    if (typeof maxClientWithAccess.getCurrentChatMemberAccess !== 'function') {
      if (action === 'delete_message') {
        throw new ServiceUnavailableException(
          'Не удалось подтвердить право бота MAX удалять сообщения. Повторите попытку позже.',
        );
      }
      return candidateBotIds[0];
    }

    const persistRecoveredCandidateIfNeeded = async (candidateBotId: string) => {
      if (
        !registryCandidateBotIds.has(candidateBotId) ||
        routeCandidateBotIds.has(candidateBotId) ||
        membershipCandidateBotIds.has(candidateBotId)
      ) {
        return;
      }

      await this.persistRecoveredManualActionBotAssignment(
        normalizedChatId,
        candidateBotId,
        entityType,
      );
    };

    for (const candidateBotId of candidateBotIds) {
      try {
        const probeStartedAt = new Date();
        const access = await maxClientWithAccess.getCurrentChatMemberAccess(normalizedChatId, {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          botId: candidateBotId,
          bypassCache: true,
        });
        const persisted = await this.recordManualActionBotAccessProbe({
          chatId: normalizedChatId,
          botId: candidateBotId,
          access,
          checkedAt: probeStartedAt,
          source: 'admin_manual_moderation_candidate',
        });
        if (
          persisted &&
          this.hasManualModerationBotActionAccess(access, action, entityType) &&
          (await this.isManualActionBotInAuthoritativeRoute(
            {
              purpose: 'moderation_action',
              chatId: normalizedChatId,
              action,
              fallbackToPrimary: true,
            },
            candidateBotId,
          ))
        ) {
          await persistRecoveredCandidateIfNeeded(candidateBotId);
          return candidateBotId;
        }
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          continue;
        }

        this.throwManualModerationTransientMaxError(error);
        this.logger.debug(
          {
            chatId: normalizedChatId,
            action,
            botId: candidateBotId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to verify action-specific bot candidate for manual moderation',
        );
      }
    }

    if (!this.maxBotRegistry) {
      return this.resolveLegacyManualModerationActionBotAssignment(
        normalizedChatId,
        action,
        entityType,
      );
    }

    throw new ForbiddenException(
      'Не найден бот MAX с подтвержденным правом выполнить действие модерации в этом чате.',
    );
  }

  private async persistRecoveredManualActionBotAssignment(
    chatId: string,
    botId: string,
    entityType: ChatEntityType = ChatEntityType.CHAT,
  ): Promise<void> {
    try {
      if (this.maxBotLinkService?.bindChatToBot) {
        await this.maxBotLinkService.bindChatToBot({
          chatId,
          entityType,
          botId,
        });
        return;
      }

      await this.prisma.chat.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          title: `Chat ${chatId}`,
          entityType,
          ...this.buildResolvedBotAssignmentData(botId),
        },
        update: {},
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist recovered chat bot assignment for manual moderation action',
      );
    }
  }

  private hasManualModerationBotActionAccess(
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner' | 'permissions'>,
    action: ManualModerationBotAction,
    entityType: ChatEntityType = ChatEntityType.CHAT,
  ): boolean {
    if (action === 'delete_message') {
      return hasConfirmedDeleteMessageAccess(
        {
          checkedAt: null,
          isAdmin: access.isAdmin,
          isOwner: access.isOwner,
          permissions: access.permissions,
        },
        entityType,
      );
    }
    if (access.isOwner) {
      return true;
    }
    if (!access.isAdmin) {
      return false;
    }
    if (access.permissions.length === 0) {
      return true;
    }
    return access.permissions.some((permission) => this.isAddRemoveMembersPermission(permission));
  }

  private async resolveLegacyManualModerationActionBotAssignment(
    chatId: string,
    action: ManualModerationBotAction,
    entityType: ChatEntityType,
  ): Promise<string | undefined> {
    const botId = await this.resolveManualActionBotAssignment(chatId, entityType);
    if (action !== 'delete_message') {
      return botId;
    }

    await this.assertBotCanDeleteMessages(chatId, botId, entityType);
    return botId;
  }

  private async resolveManualActionBotAssignment(
    chatId: string,
    entityType: ChatEntityType = ChatEntityType.CHAT,
  ): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    const persistedBotId = await this.resolveChatBotIdForRead(normalizedChatId);
    let fallbackBotId = persistedBotId;
    let transientAccessPressure = false;
    const seenBotIds = new Set<string>();

    if (persistedBotId) {
      seenBotIds.add(persistedBotId);
      try {
        const probeStartedAt = new Date();
        const access = await this.maxClient.getCurrentChatMemberAccess(normalizedChatId, {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          botId: persistedBotId,
          bypassCache: true,
        });
        const persisted = await this.recordManualActionBotAccessProbe({
          chatId: normalizedChatId,
          botId: persistedBotId,
          access,
          checkedAt: probeStartedAt,
          source: 'admin_manual_action_persisted',
        });
        if (
          persisted &&
          (access.isAdmin || access.isOwner) &&
          (await this.isManualActionBotInAuthoritativeRoute(
            { purpose: 'read', chatId: normalizedChatId },
            persistedBotId,
          ))
        ) {
          return persistedBotId;
        }

        this.logger.warn(
          {
            chatId: normalizedChatId,
            botId: persistedBotId,
          },
          'Persisted chat bot assignment is no longer admin-capable for manual action',
        );
        fallbackBotId = undefined;
      } catch (error: unknown) {
        if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
          transientAccessPressure = true;
          this.logger.debug(
            {
              chatId: normalizedChatId,
              botId: persistedBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Deferring persisted chat bot assignment after transient MAX API pressure',
          );
        } else if (isBotAdminLookupDeniedError(error)) {
          fallbackBotId = undefined;
        } else {
          this.logger.debug(
            {
              chatId: normalizedChatId,
              botId: persistedBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to verify persisted chat bot assignment for manual action',
          );
        }
      }
    }

    for (const bot of this.maxBotRegistry?.getActionableBots() ?? []) {
      if (seenBotIds.has(bot.id)) {
        continue;
      }
      seenBotIds.add(bot.id);
      try {
        const probeStartedAt = new Date();
        const access = await this.maxClient.getCurrentChatMemberAccess(normalizedChatId, {
          trafficClass: 'critical',
          actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
          botId: bot.id,
          bypassCache: true,
        });
        const persisted = await this.recordManualActionBotAccessProbe({
          chatId: normalizedChatId,
          botId: bot.id,
          access,
          checkedAt: probeStartedAt,
          source: 'admin_manual_action_recovery',
        });
        if (!persisted) {
          continue;
        }
        if (!access.isAdmin && !access.isOwner) {
          continue;
        }
        if (
          !(await this.isManualActionBotInAuthoritativeRoute(
            { purpose: 'read', chatId: normalizedChatId },
            bot.id,
          ))
        ) {
          continue;
        }

        try {
          if (this.maxBotLinkService?.bindChatToBot) {
            await this.maxBotLinkService.bindChatToBot({
              chatId: normalizedChatId,
              entityType,
              botId: bot.id,
            });
          } else {
            await this.prisma.chat.upsert({
              where: { id: normalizedChatId },
              create: {
                id: normalizedChatId,
                title: `Chat ${normalizedChatId}`,
                entityType,
                ...this.buildResolvedBotAssignmentData(bot.id),
              },
              update: {},
            });
          }
        } catch (persistError: unknown) {
          this.logger.warn(
            {
              chatId: normalizedChatId,
              botId: bot.id,
              err: persistError instanceof Error ? persistError.message : String(persistError),
            },
            'Failed to persist recovered chat bot assignment for manual action',
          );
        }

        return bot.id;
      } catch (error: unknown) {
        if (isBotAdminLookupDeniedError(error)) {
          continue;
        }

        if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
          transientAccessPressure = true;
          this.logger.debug(
            {
              chatId: normalizedChatId,
              botId: bot.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'Stopped probing actionable bots for manual action after transient MAX API pressure',
          );
          break;
        }

        this.logger.debug(
          {
            chatId: normalizedChatId,
            botId: bot.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to probe actionable bot while resolving manual action bot assignment',
        );
      }
    }

    if (transientAccessPressure) {
      throw new ServiceUnavailableException(
        'Не удалось подтвердить права бота MAX для действия. Повторите попытку позже.',
      );
    }

    return fallbackBotId;
  }

  private async resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined> {
    return (
      (await this.resolveAssistBotAssignment(chatId, 'access_prewarm')) ??
      (await this.resolveBotAssignment(chatId))
    );
  }

  private async refreshExecutionReadinessAfterChatSettingsUpdate(
    chatId: string,
    settings: ChatSettings,
  ): Promise<void> {
    await refreshBots(
      this.maxBotExecutionPlanner,
      this.logger,
      chatId,
      'chat',
      'chat settings update',
    );
    this.scheduleDestructiveModerationAdminRosterWarmup(chatId, settings);

    if (!isRequiredSubscriptionCurrentlyActive(settings)) {
      return;
    }

    await this.refreshRequiredSubscriptionAccessSnapshots(
      settings.requiredSubscriptionChannelIds,
      'required subscription settings update',
    );
  }

  private scheduleDestructiveModerationAdminRosterWarmup(
    chatId: string,
    settings: Pick<ChatSettings, 'nightModeEnabled' | 'nightModeForceCloseEnabled'>,
  ): void {
    if (
      typeof this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync !== 'function' ||
      (!settings.nightModeEnabled && !settings.nightModeForceCloseEnabled)
    ) {
      return;
    }

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId,
        entityType: 'chat',
        source: 'moderation_destructive_path',
        retryUntilMs: null,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule destructive moderation admin roster warmup after settings update',
        );
      });
  }

  private async refreshApplySettingsToAllReadiness(params: {
    chatIds: readonly string[];
    shouldRefreshRequiredSubscription: boolean;
    requiredSubscriptionChannelIds: readonly string[];
  }): Promise<void> {
    await mapWithConcurrencyLimit(
      [...params.chatIds],
      APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_CONCURRENCY,
      async (chatId) => {
        await sleepIfNeeded(APPLY_SETTINGS_TO_ALL_READINESS_REFRESH_SPACING_MS);
        await refreshBots(
          this.maxBotExecutionPlanner,
          this.logger,
          chatId,
          'chat',
          'chat settings apply-to-all',
        );
      },
    );

    if (!params.shouldRefreshRequiredSubscription) {
      return;
    }

    await this.refreshRequiredSubscriptionAccessSnapshots(
      params.requiredSubscriptionChannelIds,
      'required subscription settings apply-to-all',
    );
  }

  private async resolveDeliveryBotAssignmentRouteAware(
    chatId: string,
  ): Promise<ChannelSuggestionPublicationBotAssignment> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return { botId: undefined, routeResolved: false, candidateBotIds: [] };
    }

    const route = await this.resolveUnifiedBotRoute({
      purpose: 'send_message',
      chatId: normalizedChatId,
    });
    if (route) {
      const candidateBotIds = Array.from(
        new Set(
          (route.candidateBotIds ?? [])
            .map((botId) => this.readTrimmedString(botId))
            .filter((botId): botId is string => Boolean(botId)),
        ),
      );
      return {
        botId: this.readTrimmedString(route.botId) ?? undefined,
        routeResolved: true,
        candidateBotIds,
      };
    }
    const sendBotId = await this.maxBotLinkService?.resolveBotIdForSend?.({
      chatId: normalizedChatId,
    });
    if (sendBotId) {
      return { botId: sendBotId, routeResolved: false, candidateBotIds: [] };
    }

    const persisted = await this.prisma.chat.findUnique({
      where: { id: normalizedChatId },
      select: { primaryBotId: true, botId: true },
    });
    const persistedBotId =
      this.readTrimmedString(persisted?.primaryBotId ?? persisted?.botId) ?? undefined;
    return {
      botId: persistedBotId,
      routeResolved: false,
      candidateBotIds: [],
    };
  }

  private async resolveDeliveryBotAssignment(chatId: string): Promise<string | undefined> {
    return (await this.resolveDeliveryBotAssignmentRouteAware(chatId)).botId;
  }

  private async resolveChannelSuggestionPublicationBotAssignment(
    chatId: string,
  ): Promise<ChannelSuggestionPublicationBotAssignment> {
    const assignment = await this.resolveDeliveryBotAssignmentRouteAware(chatId);
    if (assignment.routeResolved && !assignment.botId) {
      throw new ForbiddenException(
        'Не найден бот MAX с подтвержденным правом публиковать сообщения в этом канале.',
      );
    }
    return assignment;
  }

  private async resolveSendActionBotAssignment(
    chatId: string,
    entityType: ChatEntityType = ChatEntityType.CHAT,
  ): Promise<string | undefined> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return undefined;
    }

    const deliveryAssignment = await this.resolveDeliveryBotAssignmentRouteAware(normalizedChatId);
    if (deliveryAssignment.botId) {
      return deliveryAssignment.botId;
    }
    if (deliveryAssignment.routeResolved) {
      return undefined;
    }

    return this.resolveManualActionBotAssignment(normalizedChatId, entityType);
  }

  private async resolveAssistBotAssignment(
    chatId: string,
    capability: ManagedEntityBotCapability,
  ): Promise<string | undefined> {
    const route = await this.resolveUnifiedBotRoute({
      purpose: 'capability',
      chatId,
      capability,
      fallbackToPrimary: true,
    });
    if (route) {
      return route.botId ?? undefined;
    }

    return (
      (await this.maxBotLinkService?.resolveBotIdForCapability?.({
        chatId,
        capability,
      })) ?? undefined
    );
  }

  private async resolveCurrentBotUserId(
    chatId: string,
    botId?: string | null,
  ): Promise<string | null> {
    return resolveAdminBotUserId({
      chatId,
      botId,
      registry: this.maxBotRegistry,
      maxClient: this.maxClient,
      onUnavailable: (error) =>
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to resolve current bot user id for chat admin filtering',
        ),
    });
  }

  private async resolveKnownBotUserIdsForChat(
    chatId: string,
    preferredBotIds: ReadonlyArray<string | null | undefined> = [],
  ): Promise<Set<string>> {
    const knownBotUserIds = new Set<string>();
    const candidateBotIds = new Set<string>();

    for (const preferredBotId of preferredBotIds) {
      const normalizedBotId =
        this.maxBotRegistry?.getBotById(preferredBotId)?.id ??
        this.readTrimmedString(preferredBotId);
      if (normalizedBotId) {
        candidateBotIds.add(normalizedBotId);
      }
    }

    for (const candidateBotId of await this.resolveCandidateBotIdsForChat(chatId)) {
      candidateBotIds.add(candidateBotId);
    }

    for (const botUserId of [this.explicitBotContactId, this.ownBotUserId]) {
      const normalizedBotUserId = this.readTrimmedString(botUserId);
      if (normalizedBotUserId) {
        knownBotUserIds.add(normalizedBotUserId);
      }
    }

    const currentContextBotUserId = this.readTrimmedString(
      await this.resolveCurrentBotUserId(chatId),
    );
    if (currentContextBotUserId) {
      knownBotUserIds.add(currentContextBotUserId);
    }

    for (const candidateBotId of candidateBotIds) {
      const resolvedContactId = this.dialogLinkHelper.resolveBotContactId(candidateBotId);
      if (resolvedContactId) {
        knownBotUserIds.add(resolvedContactId);
      }
    }

    const resolvedBotUserIds = await mapWithConcurrencyLimit(
      [...candidateBotIds],
      3,
      async (candidateBotId) => this.resolveCurrentBotUserId(chatId, candidateBotId),
    );
    for (const resolvedBotUserId of resolvedBotUserIds) {
      const normalizedBotUserId = this.readTrimmedString(resolvedBotUserId);
      if (normalizedBotUserId) {
        knownBotUserIds.add(normalizedBotUserId);
      }
    }

    return knownBotUserIds;
  }

  private async resolveCandidateBotIdsForChat(
    chatId: string,
    options: {
      includeDiscoveryFallback?: boolean;
    } = {},
  ): Promise<string[]> {
    const persisted = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        botId: true,
        primaryBotId: true,
        botMemberships: {
          where: {
            status: ChatBotMembershipStatus.ACTIVE,
          },
          select: {
            botId: true,
          },
        },
      },
    });

    const resolved = new Set<string>();
    for (const botId of [
      this.readTrimmedString(persisted?.primaryBotId),
      this.readTrimmedString(persisted?.botId),
      ...((persisted?.botMemberships ?? []).map((membership) =>
        this.readTrimmedString(membership.botId),
      ) as Array<string | null>),
    ]) {
      const normalizedBotId = this.maxBotRegistry?.getBotById(botId)?.id ?? null;
      if (normalizedBotId && this.isManagedEntityRuntimeBotId(normalizedBotId)) {
        resolved.add(normalizedBotId);
      }
    }

    if (options.includeDiscoveryFallback === true) {
      for (const bot of this.maxBotRegistry?.getDiscoveryBots() ?? []) {
        resolved.add(bot.id);
      }
    }

    return [...resolved];
  }

  private async loadRemoteAdminAccessForBot(
    chatId: string,
    userId: string,
    botId: string | null,
    probeStartedAt: Date,
    options: {
      trafficClass?: 'critical' | 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<AdminAccessResolution> {
    try {
      const requestOptions = {
        actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
        ...(options.trafficClass ? { trafficClass: options.trafficClass } : {}),
        ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
        ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
        ...(botId ? { botId } : {}),
      } as const;
      const hasRequestOptions = Object.keys(requestOptions).length > 0;
      const normalizedUserId = userId.trim();
      const userIdVariants =
        this.managedEntityAccessRuntime.buildAdminAccessUserIdVariants(normalizedUserId);
      const botContactId = this.dialogLinkHelper.resolveBotContactId(botId);

      if (typeof this.maxClient.getChatMembersAccess === 'function') {
        const lookupIds = Array.from(
          new Set(
            [normalizedUserId, botContactId]
              .map((value) => this.normalizeMaxApiAdminLookupUserId(value))
              .filter((value): value is string => Boolean(value)),
          ),
        );
        const accessByUserId = hasRequestOptions
          ? await this.maxClient.getChatMembersAccess(chatId, lookupIds, requestOptions)
          : await this.maxClient.getChatMembersAccess(chatId, lookupIds);
        const botAccess =
          this.managedEntityAccessRuntime.readAdminAccessByUserIdVariants(
            accessByUserId,
            botContactId,
          ) ??
          (hasRequestOptions
            ? await this.maxClient.getCurrentChatMemberAccess(chatId, requestOptions)
            : await this.maxClient.getCurrentChatMemberAccess(chatId));
        const botRole = this.resolveManagedEntityAccessRole(botAccess);

        if (!botAccess.isAdmin && !botAccess.isOwner) {
          return {
            status: 'denied',
            source: 'remote',
            reason: 'bot_not_admin',
            botRole,
            probeStartedAt,
          };
        }

        const userAccess =
          this.managedEntityAccessRuntime.readAdminAccessByUserIdVariants(
            accessByUserId,
            normalizedUserId,
          ) ??
          (botContactId && userIdVariants.includes(botContactId.toLowerCase()) ? botAccess : null);
        const userRole = this.resolveManagedEntityAccessRole(userAccess);
        if (userAccess?.isAdmin === true || userAccess?.isOwner === true) {
          return {
            status: 'granted',
            source: 'remote',
            userRole,
            botRole,
            probeStartedAt,
          };
        }

        return {
          status: 'denied',
          source: 'remote',
          reason: 'user_not_admin',
          userRole,
          botRole,
          probeStartedAt,
        };
      }

      const adminIds = hasRequestOptions
        ? await this.maxClient.getChatAdminIds(chatId, requestOptions)
        : await this.maxClient.getChatAdminIds(chatId);
      const adminUserIdVariants = new Set(
        adminIds.flatMap((adminId) =>
          this.managedEntityAccessRuntime.buildAdminAccessUserIdVariants(adminId),
        ),
      );
      return userIdVariants.some((candidate) => adminUserIdVariants.has(candidate))
        ? {
            status: 'granted',
            source: 'remote',
            userRole: 'ADMIN',
            botRole: 'ADMIN',
            probeStartedAt,
          }
        : {
            status: 'denied',
            source: 'remote',
            reason: 'user_not_admin',
            userRole: 'MEMBER',
            botRole: 'ADMIN',
            probeStartedAt,
          };
    } catch (error: unknown) {
      if (isMaxApiThrottleError(error)) {
        return {
          status: 'throttled',
          error,
          probeStartedAt,
        };
      }

      if (isBotAdminLookupDeniedError(error)) {
        return {
          status: 'denied',
          source: 'remote',
          reason: 'bot_not_admin',
          probeStartedAt,
        };
      }

      const logData = {
        chatId,
        userId,
        botId: botId ?? 'legacy',
        err: error instanceof Error ? error.message : String(error),
      };
      if (isMaxApiTimeoutError(error)) {
        this.logger.log(
          logData,
          'Chat hidden after transient admin access validation timeout for candidate bot',
        );
      } else {
        this.logger.warn(
          logData,
          'Chat hidden: failed to validate bot/user admin access for candidate bot',
        );
      }
      return {
        status: 'unknown',
        error,
        probeStartedAt,
      };
    }
  }

  private normalizeMaxApiAdminLookupUserId(value: string | null | undefined): string | null {
    const normalized = this.readTrimmedString(value)?.toLowerCase();
    if (!normalized) {
      return null;
    }

    return /^id\d+$/.test(normalized) ? normalized.slice(2) : normalized;
  }

  private async loadRemoteAdminAccess(
    chatId: string,
    userId: string,
    options: {
      entityType?: ManagedEntityType;
      candidateBotIds?: readonly string[];
      trafficClass?: 'critical' | 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
      allowPersistedFallback?: boolean;
    } = {},
  ): Promise<AdminAccessResolution> {
    const probeStartedAt = new Date();
    const discoveryCandidateBotIds = this.normalizeRuntimeManagedEntityBotIds(
      options.candidateBotIds ?? [],
    );
    const persistedCandidateBotIds = await this.resolveCandidateBotIdsForChat(chatId, {
      includeDiscoveryFallback: false,
    });
    const candidateBotIds = Array.from(
      new Set([...discoveryCandidateBotIds, ...persistedCandidateBotIds]),
    );
    if (candidateBotIds.length === 0) {
      const resolution = await this.loadRemoteAdminAccessForBot(
        chatId,
        userId,
        null,
        probeStartedAt,
        options,
      );
      if (
        resolution.status === 'denied' &&
        resolution.reason === 'bot_not_admin' &&
        options.entityType &&
        options.allowPersistedFallback !== false
      ) {
        const edgeResolution = await this.resolveFreshManagedEntityAccessEdgeFallback(
          chatId,
          userId,
          options.entityType,
        );
        if (edgeResolution) {
          return edgeResolution;
        }
      }

      if (resolution.status === 'granted' || resolution.status === 'denied') {
        const persisted = await this.recordRemoteManagedEntityAccessEdge(
          chatId,
          userId,
          null,
          options,
          resolution,
        );
        if (!persisted) {
          return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
        }
        if (resolution.status === 'denied') {
          const pruned = await this.managedEntityAccessRuntime.prunePersistedChatAccessBestEffort(
            chatId,
            userId,
            resolution.reason === 'user_not_admin'
              ? 'remote_admin_access:user_denied'
              : 'remote_admin_access:bot_denied',
            {
              eventAt: probeStartedAt,
              state: resolution.reason === 'user_not_admin' ? 'USER_DENIED' : 'BOT_DENIED',
              cacheAlreadyPublished: true,
            },
          );
          if (!pruned) {
            return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
          }
        }
        if (!(await this.publishRemoteAdminAccessEpoch(chatId, userId, resolution))) {
          return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
        }
      }

      return resolution;
    }

    let sawUserDenied = false;
    let sawBotDenied = false;
    let throttledError: unknown = null;
    let unknownError: unknown = null;

    for (const botId of candidateBotIds) {
      const resolution = await this.loadRemoteAdminAccessForBot(
        chatId,
        userId,
        botId,
        probeStartedAt,
        options,
      );
      const persisted = await this.recordRemoteManagedEntityAccessEdge(
        chatId,
        userId,
        botId,
        options,
        resolution,
      );
      if (!persisted) {
        return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
      }
      if (resolution.status === 'granted') {
        if (!(await this.publishRemoteAdminAccessEpoch(chatId, userId, resolution))) {
          return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
        }
        return resolution;
      }

      if (resolution.status === 'denied') {
        if (resolution.reason === 'user_not_admin') {
          sawUserDenied = true;
        } else {
          sawBotDenied = true;
        }
        continue;
      }

      if (resolution.status === 'throttled' && throttledError === null) {
        throttledError = resolution.error;
        continue;
      }

      if (resolution.status === 'unknown' && unknownError === null) {
        unknownError = resolution.error;
      }
    }

    if (sawUserDenied) {
      const pruned = await this.managedEntityAccessRuntime.prunePersistedChatAccessBestEffort(
        chatId,
        userId,
        'remote_admin_access:user_denied',
        {
          eventAt: probeStartedAt,
          state: 'USER_DENIED',
          cacheAlreadyPublished: true,
        },
      );
      if (!pruned) {
        return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
      }
      const resolution = {
        status: 'denied',
        source: 'remote',
        reason: 'user_not_admin',
        probeStartedAt,
      } satisfies AdminAccessResolution;
      if (!(await this.publishRemoteAdminAccessEpoch(chatId, userId, resolution))) {
        return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
      }
      return resolution;
    }

    if (throttledError) {
      return {
        status: 'throttled',
        error: throttledError,
      };
    }

    if (unknownError) {
      return {
        status: 'unknown',
        error: unknownError,
      };
    }

    if (sawBotDenied) {
      if (options.entityType && options.allowPersistedFallback !== false) {
        const edgeResolution = await this.resolveFreshManagedEntityAccessEdgeFallback(
          chatId,
          userId,
          options.entityType,
        );
        if (edgeResolution) {
          return edgeResolution;
        }
      }
      const pruned = await this.managedEntityAccessRuntime.prunePersistedChatAccessBestEffort(
        chatId,
        userId,
        'remote_admin_access:bot_denied',
        {
          eventAt: probeStartedAt,
          state: 'BOT_DENIED',
          cacheAlreadyPublished: true,
        },
      );
      if (!pruned) {
        return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
      }
      const resolution = {
        status: 'denied',
        source: 'remote',
        reason: 'bot_not_admin',
        probeStartedAt,
      } satisfies AdminAccessResolution;
      if (!(await this.publishRemoteAdminAccessEpoch(chatId, userId, resolution))) {
        return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
      }
      return resolution;
    }

    const pruned = await this.managedEntityAccessRuntime.prunePersistedChatAccessBestEffort(
      chatId,
      userId,
      'remote_admin_access:bot_denied',
      {
        eventAt: probeStartedAt,
        state: 'BOT_DENIED',
        cacheAlreadyPublished: true,
      },
    );
    if (!pruned) {
      return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
    }
    const resolution = {
      status: 'denied',
      source: 'remote',
      reason: 'bot_not_admin',
      probeStartedAt,
    } satisfies AdminAccessResolution;
    if (!(await this.publishRemoteAdminAccessEpoch(chatId, userId, resolution))) {
      return this.createSupersededRemoteAdminAccessResolution(probeStartedAt);
    }
    return resolution;
  }

  private async recordRemoteManagedEntityAccessEdge(
    chatId: string,
    userId: string,
    botId: string | null,
    options: {
      entityType?: ManagedEntityType;
    },
    resolution: AdminAccessResolution,
  ): Promise<boolean> {
    if (resolution.status === 'unknown' || resolution.status === 'throttled') {
      return true;
    }
    if (!resolution.probeStartedAt) {
      return false;
    }

    return this.managedEntityAccessRuntime.persistRemoteManagedEntityAccessEdge({
      chatId,
      userId,
      botId,
      entityType: options.entityType,
      resolution,
      probeStartedAt: resolution.probeStartedAt,
    });
  }

  private async publishRemoteAdminAccessEpoch(
    chatId: string,
    userId: string,
    resolution: Extract<AdminAccessResolution, { status: 'granted' | 'denied' }>,
  ): Promise<boolean> {
    const probeStartedAt = resolution.probeStartedAt;
    if (!probeStartedAt) {
      return false;
    }
    if (typeof this.chatContextCache.applyAdminAccessEpochMutation !== 'function') {
      return true;
    }

    try {
      return await this.chatContextCache.applyAdminAccessEpochMutation({
        chatId,
        userId,
        state:
          resolution.status === 'granted'
            ? 'granted'
            : resolution.reason === 'user_not_admin'
              ? 'user_denied'
              : 'bot_denied',
        eventAt: probeStartedAt,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          status: resolution.status,
          probeStartedAt: probeStartedAt.toISOString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to publish remote admin access epoch',
      );
      return false;
    }
  }

  private createSupersededRemoteAdminAccessResolution(probeStartedAt: Date): AdminAccessResolution {
    return {
      status: 'unknown',
      error: new Error('Remote admin access probe was superseded'),
      probeStartedAt,
    };
  }

  private async resolveUserAndBotAdminAccess(
    chatId: string,
    userId: string,
    options: {
      bypassNegativeCache?: boolean;
      entityType?: ManagedEntityType;
      candidateBotIds?: readonly string[];
      trafficClass?: 'critical' | 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
      allowPersistedFallback?: boolean;
      bypassPositiveCache?: boolean;
    } = {},
  ): Promise<AdminAccessResolution> {
    const cached = (await this.chatContextCache.getAdminAccess?.(chatId, userId)) ?? null;
    if (cached === 'granted' && options.bypassPositiveCache !== true) {
      return {
        status: 'granted',
        source: 'cache',
      };
    }

    if (cached === 'user_denied' && options.bypassNegativeCache !== true) {
      return {
        status: 'denied',
        source: 'cache',
        reason: 'user_not_admin',
      };
    }

    if (cached === 'bot_denied' && options.bypassNegativeCache !== true) {
      return {
        status: 'denied',
        source: 'cache',
        reason: 'bot_not_admin',
      };
    }

    const key = this.buildAdminAccessCheckKey(chatId, userId, options);
    const inFlight = this.adminAccessChecks.get(key);
    if (inFlight) {
      return options.allowPersistedFallback === false
        ? inFlight
        : this.withAllowlistFallback(chatId, userId, options.entityType, inFlight);
    }

    const pending = this.loadRemoteAdminAccess(chatId, userId, {
      entityType: options.entityType,
      candidateBotIds: options.candidateBotIds,
      trafficClass: options.trafficClass,
      sourceTag: options.sourceTag,
      timeoutMs: options.timeoutMs,
      allowPersistedFallback: options.allowPersistedFallback,
    });
    this.adminAccessChecks.set(key, pending);

    try {
      return await (options.allowPersistedFallback === false
        ? pending
        : this.withAllowlistFallback(chatId, userId, options.entityType, pending));
    } finally {
      this.adminAccessChecks.delete(key);
    }
  }

  private buildAdminAccessCheckKey(
    chatId: string,
    userId: string,
    options: {
      candidateBotIds?: readonly string[];
      entityType?: ManagedEntityType;
      trafficClass?: 'critical' | 'interactive' | 'background';
      timeoutMs?: number;
      allowPersistedFallback?: boolean;
    },
  ): string {
    const trafficClass = options.trafficClass ?? 'interactive';
    const timeoutKey =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : 'default';

    const candidateBotIdsKey = this.normalizeRuntimeManagedEntityBotIds(
      options.candidateBotIds ?? [],
    )
      .sort()
      .join(',');
    const entityType = options.entityType ?? 'unknown';
    const fallbackMode = options.allowPersistedFallback === false ? 'strict' : 'fallback';

    return [
      chatId,
      userId,
      entityType,
      fallbackMode,
      trafficClass,
      timeoutKey,
      candidateBotIdsKey,
    ].join(':');
  }

  private async withAllowlistFallback(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType | undefined,
    resolutionPromise: Promise<AdminAccessResolution>,
  ): Promise<AdminAccessResolution> {
    const resolution = await resolutionPromise;
    if (resolution.status === 'granted') {
      return resolution;
    }
    if (resolution.status === 'denied') {
      return resolution;
    }

    if (entityType) {
      const edgeResolution = await this.resolveFreshManagedEntityAccessEdgeFallback(
        chatId,
        userId,
        entityType,
      );
      if (edgeResolution) {
        return edgeResolution;
      }
    }

    if (resolution.status === 'unknown' || resolution.status === 'throttled') {
      if (!(await this.hasPersistedChatAccess(chatId, userId))) {
        return resolution;
      }
      if (!(await this.canUsePersistedChatAccessFallback(chatId))) {
        return resolution;
      }
      if (
        resolution.probeStartedAt &&
        !(await this.managedEntityAccessRuntime.isRemoteAdminAccessProbeCurrent(
          chatId,
          userId,
          resolution.probeStartedAt,
        ))
      ) {
        return resolution;
      }

      this.logger.log(
        {
          chatId,
          userId,
        },
        'Using persisted admin access allowlist after transient MAX API failure',
      );
      return {
        status: 'granted',
        source: 'allowlist_fallback',
      };
    }

    return resolution;
  }

  private async resolveFreshManagedEntityAccessEdgeFallback(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<Extract<AdminAccessResolution, { status: 'granted' }> | null> {
    const client = this.getManagedEntityAccessEdgeClient();
    if (!client) {
      return null;
    }

    try {
      const rows = await client.findMany({
        where: {
          chatId,
          userId: {
            in: this.managedEntityAccessRuntime.buildAdminAccessUserIdVariants(userId),
          },
          entityType: toPrismaEntityType(entityType),
          state: 'GRANTED',
          OR: [
            { expiresAt: { gt: new Date() } },
            {
              expiresAt: null,
              checkedAt: { gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS) },
            },
          ],
        },
        select: {
          chatId: true,
          userId: true,
          botId: true,
          checkedAt: true,
        },
      });
      const activeMembershipKeys = await this.readActiveManagedEntityMembershipKeys(rows, {
        userId,
        requestedItems: 1,
        source: 'admin_access_edge_fallback',
      });
      const activeGrantedEdges = rows.filter((row) => {
        const rowChatId = this.readTrimmedString(row.chatId);
        const botId = this.normalizeManagedEntityAccessBotId(row.botId);
        return (
          rowChatId === chatId &&
          Boolean(botId) &&
          activeMembershipKeys.has(this.buildManagedEntityRepairEdgeKey(rowChatId, botId ?? ''))
        );
      });
      const checkedAt = activeGrantedEdges.reduce<Date | null>((latest, row) => {
        if (!(row.checkedAt instanceof Date) || !Number.isFinite(row.checkedAt.getTime())) {
          return latest;
        }
        return !latest || row.checkedAt > latest ? row.checkedAt : latest;
      }, null);
      if (
        !checkedAt ||
        !(await this.managedEntityAccessRuntime.isRemoteAdminAccessProbeCurrent(
          chatId,
          userId,
          checkedAt,
        ))
      ) {
        return null;
      }

      const cacheApplied = await this.chatContextCache.applyAdminAccessEpochMutation({
        chatId,
        userId,
        state: 'granted',
        eventAt: checkedAt,
      });
      if (!cacheApplied) {
        return null;
      }
      this.logger.log(
        {
          chatId,
          userId,
          entityType,
        },
        'Using fresh managed entity access edge after MAX admin access denial',
      );
      return {
        status: 'granted',
        source: 'allowlist_fallback',
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          entityType,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to inspect fresh managed entity access edge fallback',
      );
      return null;
    }
  }

  private async canUsePersistedChatAccessFallback(chatId: string): Promise<boolean> {
    try {
      const memberships = await this.prisma.chatBotMembership.findMany({
        where: {
          chatId,
          status: ChatBotMembershipStatus.ACTIVE,
        },
        select: {
          botId: true,
          permissionsSnapshot: true,
        },
      });
      const knownMemberships = memberships.filter(
        (membership) => this.maxBotRegistry?.getBotById(membership.botId) ?? true,
      );
      if (knownMemberships.length === 0) {
        return false;
      }

      let sawUnknownSnapshot = false;
      for (const membership of knownMemberships) {
        const snapshot = this.normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
        if (!snapshot) {
          sawUnknownSnapshot = true;
          continue;
        }
        if (snapshot.isAdmin || snapshot.isOwner) {
          return true;
        }
      }

      return sawUnknownSnapshot;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to inspect bot memberships before persisted admin access fallback',
      );
      return false;
    }
  }

  private normalizeMembershipAccessSnapshot(
    value: unknown,
  ): { isAdmin: boolean; isOwner: boolean } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    return {
      isAdmin: row.isAdmin === true,
      isOwner: row.isOwner === true,
    };
  }

  private isManagedEntitiesRefreshThrottledError(
    error: unknown,
  ): error is ManagedEntitiesRefreshThrottledError {
    return error instanceof ManagedEntitiesRefreshThrottledError;
  }

  private async isManagedEntitiesRefreshBackoffActive(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<boolean> {
    const untilMs = this.managedEntitiesRefreshBackoffUntilMs.get(key) ?? 0;
    const memoryActive = untilMs > Date.now();
    if (!memoryActive && untilMs > 0) {
      this.managedEntitiesRefreshBackoffUntilMs.delete(key);
    }

    let persistedActive = false;
    try {
      persistedActive = await this.chatContextCache.isManagedEntitiesRefreshBackoffActive(
        userId,
        entityType,
      );
    } catch {
      persistedActive = false;
    }

    return (
      memoryActive ||
      persistedActive ||
      (await this.getManagedRefreshSourceBackoffRemainingMs()) > 0
    );
  }

  private buildManagedEntitiesRefreshCooldownKey(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): string {
    return `${userId}:${entityType}`;
  }

  private async isManagedEntitiesRefreshCooldownActive(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<boolean> {
    const untilMs = this.managedEntitiesRefreshCooldownUntilMs.get(key) ?? 0;
    const memoryActive = untilMs > Date.now();
    if (!memoryActive && untilMs > 0) {
      this.managedEntitiesRefreshCooldownUntilMs.delete(key);
    }

    try {
      return (
        memoryActive ||
        (await this.chatContextCache.isManagedEntitiesRefreshCooldownActive(userId, entityType))
      );
    } catch {
      return memoryActive;
    }
  }

  private async activateManagedEntitiesRefreshCooldown(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<void> {
    const untilMs = Date.now() + MANAGED_ENTITIES_REFRESH_SUCCESS_COOLDOWN_MS;
    this.managedEntitiesRefreshCooldownUntilMs.set(key, untilMs);
    try {
      await this.chatContextCache.activateManagedEntitiesRefreshCooldown(
        userId,
        entityType,
        Math.max(1, Math.ceil((untilMs - Date.now()) / 1000)),
      );
    } catch {
      return;
    }
  }

  private async activateManagedEntitiesRefreshBackoff(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<number> {
    const now = Date.now();
    const untilMs = Math.max(
      this.managedEntitiesRefreshBackoffUntilMs.get(key) ?? 0,
      now + MANAGED_ENTITIES_REFRESH_BACKOFF_MS,
    );
    this.managedEntitiesRefreshBackoffUntilMs.set(key, untilMs);
    const backoffMs = untilMs - now;

    try {
      await this.chatContextCache.activateManagedEntitiesRefreshBackoff(
        userId,
        entityType,
        Math.max(1, Math.ceil(backoffMs / 1000)),
      );
    } catch {
      // Keep the in-process guard even when Redis is briefly unavailable.
    }

    return backoffMs;
  }

  private async getManagedRefreshSourceBackoffRemainingMs(): Promise<number> {
    try {
      const remainingMs = await this.chatContextCache.getManagedRefreshSourceBackoffRemainingMs?.();
      if (typeof remainingMs === 'number' && remainingMs > 0) {
        return remainingMs;
      }

      return (await this.chatContextCache.isManagedRefreshSourceBackoffActive?.())
        ? MANAGED_ENTITIES_REFRESH_BACKOFF_MS
        : 0;
    } catch {
      return 0;
    }
  }

  private async getManagedEntitiesRefreshBackoffRemainingMs(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    key: string,
  ): Promise<number> {
    const untilMs = this.managedEntitiesRefreshBackoffUntilMs.get(key) ?? 0;
    const memoryRemainingMs = Math.max(0, untilMs - Date.now());
    if (memoryRemainingMs === 0 && untilMs > 0) {
      this.managedEntitiesRefreshBackoffUntilMs.delete(key);
    }

    try {
      const persistedRemainingMs =
        (await this.chatContextCache.getManagedEntitiesRefreshBackoffRemainingMs?.(
          userId,
          entityType,
        )) ?? 0;
      return Math.max(
        memoryRemainingMs,
        persistedRemainingMs,
        await this.getManagedRefreshSourceBackoffRemainingMs(),
      );
    } catch {
      return Math.max(memoryRemainingMs, await this.getManagedRefreshSourceBackoffRemainingMs());
    }
  }

  private async loadManagedEntitiesRefreshPresentationData(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ManagedEntitiesRefreshPresentation> {
    let totalCandidates: number | null = null;
    try {
      const snapshot =
        (await this.chatContextCache.getManagedEntitiesDiscoverySnapshot?.(userId, entityType)) ??
        null;
      totalCandidates = Array.isArray(snapshot) ? snapshot.length : null;
    } catch {
      totalCandidates = null;
    }

    let lastSyncedAt: string | null = null;
    try {
      lastSyncedAt =
        (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(userId, entityType)) ?? null;
    } catch {
      lastSyncedAt = null;
    }

    return {
      totalCandidates,
      lastSyncedAt,
    };
  }

  private async readManagedEntitiesLastSyncFreshness(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<{ fresh: boolean; lastSyncedAt: string | null; ageMs: number | null }> {
    let lastSyncedAt: string | null = null;
    try {
      lastSyncedAt =
        (await this.chatContextCache.getManagedEntitiesLastSyncedAt?.(userId, entityType)) ?? null;
    } catch {
      lastSyncedAt = null;
    }

    if (!lastSyncedAt) {
      return {
        fresh: false,
        lastSyncedAt: null,
        ageMs: null,
      };
    }

    const lastSyncedAtMs = Date.parse(lastSyncedAt);
    if (!Number.isFinite(lastSyncedAtMs)) {
      return {
        fresh: false,
        lastSyncedAt,
        ageMs: null,
      };
    }

    const ageMs = Date.now() - lastSyncedAtMs;
    return {
      fresh: ageMs >= 0 && ageMs < MANAGED_ENTITIES_REFRESH_FRESHNESS_WINDOW_MS,
      lastSyncedAt,
      ageMs,
    };
  }

  private async readManagedEntitiesRefreshState(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: { backoffActiveOverride?: boolean; cursorOverride?: number | null } = {},
  ): Promise<ManagedEntitiesRefreshState> {
    const refreshCooldownKey = this.buildManagedEntitiesRefreshCooldownKey(userId, entityType);
    let cursor = options.cursorOverride;
    if (cursor === undefined) {
      try {
        cursor =
          (await this.chatContextCache.getManagedEntitiesRefreshCursor?.(userId, entityType)) ??
          null;
      } catch {
        cursor = null;
      }
    }

    const backoffActive =
      options.backoffActiveOverride ??
      (await this.isManagedEntitiesRefreshBackoffActive(userId, entityType, refreshCooldownKey));

    const nextPollAfterMs = backoffActive
      ? await this.getManagedEntitiesRefreshBackoffRemainingMs(
          userId,
          entityType,
          refreshCooldownKey,
        )
      : undefined;
    const presentation = await this.loadManagedEntitiesRefreshPresentationData(userId, entityType);

    return createManagedEntitiesRefreshState(cursor, backoffActive, nextPollAfterMs, presentation);
  }

  private async isManagedEntitiesBackgroundRefreshPaused(
    reason: 'schedule' | 'job',
  ): Promise<boolean> {
    return (
      (await this.resolveManagedEntitiesBackgroundRefreshPauseDecision(reason, {
        allowRecoveryWindowRun: false,
      })) !== null
    );
  }

  private peekManagedEntitiesBackgroundRefreshPauseDecision(
    reason: 'schedule' | 'job',
    options: {
      allowRecoveryWindowRun?: boolean;
      allowQueueLagSlowPathBelowSec?: number;
    } = {},
  ): { reason: string; retryAfterMs: number } | null {
    if (this.backgroundRuntimeGovernorService) {
      const decision = this.backgroundRuntimeGovernorService.peekDecision({
        component: 'admin-managed-refresh',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        allowRecoveryWindowRun: options.allowRecoveryWindowRun === true,
        allowQueueLagSlowPathBelowSec: options.allowQueueLagSlowPathBelowSec,
      });
      if (this.shouldIgnoreManagedEntitiesQueueLagThrottleDecision(decision, options)) {
        return null;
      }
      if (!decision || decision.action === 'run') {
        return null;
      }

      return this.logManagedEntitiesBackgroundThrottleDecision(reason, decision);
    }

    const systemModeService = this.systemModeService as
      | (SystemModeService & {
          peekCachedSnapshot?: (maxAgeMs?: number) => SystemModeSnapshot | null;
          getSnapshot?: () => SystemModeSnapshot;
        })
      | undefined;
    const snapshot =
      systemModeService?.peekCachedSnapshot?.() ?? systemModeService?.getSnapshot?.() ?? null;
    if (!snapshot || snapshot.mode !== 'degrade' || isSystemModeRecoveryWindow(snapshot)) {
      return null;
    }

    return this.logManagedEntitiesSystemModePauseDecision(reason, snapshot);
  }

  private async resolveManagedEntitiesBackgroundRefreshPauseDecision(
    reason: 'schedule' | 'job',
    options: {
      allowRecoveryWindowRun?: boolean;
      allowQueueLagSlowPathBelowSec?: number;
    } = {},
  ): Promise<{ reason: string; retryAfterMs: number } | null> {
    if (this.backgroundRuntimeGovernorService) {
      const decision = await this.backgroundRuntimeGovernorService.decide({
        component: 'admin-managed-refresh',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        allowRecoveryWindowRun: options.allowRecoveryWindowRun === true,
        allowQueueLagSlowPathBelowSec: options.allowQueueLagSlowPathBelowSec,
      });
      if (this.shouldIgnoreManagedEntitiesQueueLagThrottleDecision(decision, options)) {
        return null;
      }
      if (decision.action === 'run') {
        return null;
      }

      return this.logManagedEntitiesBackgroundThrottleDecision(reason, decision);
    }

    const snapshot = await this.resolveSystemModeSnapshot();
    if (snapshot.mode !== 'degrade' || isSystemModeRecoveryWindow(snapshot)) {
      return null;
    }

    return this.logManagedEntitiesSystemModePauseDecision(reason, snapshot);
  }

  private logManagedEntitiesBackgroundThrottleDecision(
    reason: 'schedule' | 'job',
    decision: {
      action: 'run' | 'slow' | 'pause';
      reason: string;
      retryAfterMs: number;
    },
  ): { reason: string; retryAfterMs: number } {
    const now = Date.now();
    if (
      now - this.managedEntitiesDegradePauseLogAtMs >=
      MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS
    ) {
      this.managedEntitiesDegradePauseLogAtMs = now;
      this.logger.log(
        {
          reason,
          action: decision.action,
          details: decision.reason,
          retryAfterMs: decision.retryAfterMs,
        },
        'Throttled managed entities background refresh because the runtime governor detected pressure',
      );
    }

    return {
      reason: decision.reason,
      retryAfterMs: decision.retryAfterMs,
    };
  }

  private logManagedEntitiesSystemModePauseDecision(
    reason: 'schedule' | 'job',
    snapshot: Pick<SystemModeSnapshot, 'mode' | 'source' | 'reason'>,
  ): { reason: string; retryAfterMs: number } {
    const now = Date.now();
    if (
      now - this.managedEntitiesDegradePauseLogAtMs >=
      MANAGED_ENTITIES_DEGRADE_PAUSE_LOG_INTERVAL_MS
    ) {
      this.managedEntitiesDegradePauseLogAtMs = now;
      this.logger.log(
        {
          reason,
          mode: snapshot.mode,
          source: snapshot.source,
          details: snapshot.reason,
        },
        'Paused managed entities background refresh because the system is degraded',
      );
    }

    return {
      reason: snapshot.reason,
      retryAfterMs: MANAGED_ENTITIES_REFRESH_DEGRADE_PAUSE_RETRY_MS,
    };
  }

  private shouldAllowManagedEntitiesRecoveryWindowRun(options: {
    bypassRemoteCache?: boolean;
    resetRefreshCursor?: boolean;
    allowRecoveryWindowRun?: boolean;
  }): boolean {
    return (
      options.allowRecoveryWindowRun === true ||
      options.resetRefreshCursor === true ||
      options.bypassRemoteCache === true
    );
  }

  private buildManagedEntitiesBackgroundGovernorOptions(options: {
    bypassRemoteCache?: boolean;
    resetRefreshCursor?: boolean;
    allowRecoveryWindowRun?: boolean;
  }): {
    allowRecoveryWindowRun: boolean;
    allowQueueLagSlowPathBelowSec?: number;
  } {
    const allowUserTriggeredBypass = this.shouldAllowManagedEntitiesRecoveryWindowRun(options);
    return {
      allowRecoveryWindowRun: allowUserTriggeredBypass,
      allowQueueLagSlowPathBelowSec: allowUserTriggeredBypass
        ? MANAGED_ENTITIES_REFRESH_QUEUE_LAG_SLOW_PATH_MAX_SEC
        : undefined,
    };
  }

  private shouldIgnoreManagedEntitiesQueueLagThrottleDecision(
    decision:
      | {
          action: 'run' | 'slow' | 'pause';
          reason: string;
          retryAfterMs: number;
        }
      | null
      | undefined,
    options: {
      allowQueueLagSlowPathBelowSec?: number;
    },
  ): boolean {
    if (
      !decision ||
      decision.action === 'run' ||
      typeof options.allowQueueLagSlowPathBelowSec !== 'number' ||
      !Number.isFinite(options.allowQueueLagSlowPathBelowSec)
    ) {
      return false;
    }

    const match = /^user-facing queue lag ([0-9]+(?:\.[0-9]+)?)s$/u.exec(decision.reason);
    if (!match) {
      return false;
    }

    const lagSec = Number.parseFloat(match[1]);
    return Number.isFinite(lagSec) && lagSec < options.allowQueueLagSlowPathBelowSec;
  }

  private async resolveSystemModeSnapshot(): Promise<SystemModeSnapshot> {
    if (!this.systemModeService) {
      return this.createFallbackSystemModeSnapshot();
    }

    const systemModeService = this.systemModeService as SystemModeService & {
      getEffectiveSnapshot?: () => Promise<SystemModeSnapshot>;
      getSnapshot?: () => SystemModeSnapshot;
    };
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

  private async hasPersistedChatAccess(chatId: string, userId: string): Promise<boolean> {
    const rows = await this.prisma.chatAdminAllowlist.findMany({
      where: {
        chatId,
        userId,
      },
      select: {
        chatId: true,
      },
      take: 1,
    });

    return rows.length > 0;
  }

  private prunePersistedChatAccess(
    chatId: string,
    userId: string,
    options: PrunePersistedChatAccessOptions = {},
  ): Promise<boolean> {
    return this.managedEntityAccessRuntime.prunePersistedChatAccess(chatId, userId, options);
  }

  private async listChatsFromAllowlist(
    userId: string,
    entityType: ManagedEntityTypeFilter,
  ): Promise<ChatSummary[]> {
    return this.managedEntitiesSnapshotRuntime.listChatsFromAllowlist(userId, entityType);
  }

  private async listChatsFromAllowlistUncached(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    options: {
      allowLastSuccessFallback?: boolean;
    } = {},
  ): Promise<ChatSummary[]> {
    const runtimeChatScopeFilter = this.buildManagedEntitiesRuntimeChatScopeFilter();
    const whereClause =
      entityType === 'all'
        ? {
            userId,
            ...(runtimeChatScopeFilter ? { chat: runtimeChatScopeFilter } : {}),
          }
        : {
            userId,
            chat: {
              entityType: toPrismaEntityType(entityType),
              ...(runtimeChatScopeFilter ?? {}),
            },
          };
    let rows: Array<{
      chat: {
        id: string;
        title: string;
        createdAt: Date;
        entityType: ChatEntityType;
        primaryBotId?: string | null;
        botId?: string | null;
      };
    }> = [];
    const managedEntitiesReadPrisma = this.getManagedEntitiesReadPrisma();
    try {
      rows = await managedEntitiesReadPrisma.chatAdminAllowlist.findMany({
        where: whereClause,
        include: { chat: true },
        orderBy: {
          chat: {
            createdAt: 'desc',
          },
        },
      });
    } catch (error) {
      if (options.allowLastSuccessFallback !== false && isPrismaKnownError(error, 'P2024')) {
        const fallbackSnapshot = this.readManagedEntitiesLastSuccessSnapshot(userId, entityType);
        this.logger.warn(
          {
            entityType,
            fallbackItems: fallbackSnapshot.length,
            userId,
            code:
              error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code
                : ((error as { code?: string } | null)?.code ?? null),
            err: error instanceof Error ? error.message : String(error),
          },
          fallbackSnapshot.length > 0
            ? 'Using last successful managed entities snapshot because the Prisma pool is saturated'
            : 'Using empty managed entities allowlist because the Prisma pool is saturated',
        );
        return fallbackSnapshot;
      }

      throw error;
    }

    const chats = rows.map(
      (row: {
        chat: {
          id: string;
          title: string;
          createdAt: Date;
          entityType: ChatEntityType;
          primaryBotId?: string | null;
          botId?: string | null;
        };
      }) =>
        this.createManagedEntitySummary({
          id: row.chat.id,
          title: row.chat.title,
          createdAt: row.chat.createdAt.toISOString(),
          entityType: fromPrismaEntityType(row.chat.entityType),
          primaryBotId:
            this.normalizeRuntimeManagedEntityBotId(
              this.readTrimmedString(row.chat.primaryBotId) ??
                this.readTrimmedString(row.chat.botId) ??
                null,
            ) ?? null,
        }),
    );

    const unsupportedChatIds = chats
      .filter((chat) => isUnsupportedManagedChat(chat.id, chat.entityType))
      .map((chat) => chat.id);
    if (unsupportedChatIds.length > 0) {
      try {
        await this.prisma.chatAdminAllowlist.deleteMany({
          where: {
            userId,
            chatId: {
              in: unsupportedChatIds,
            },
          },
        });
        this.invalidateManagedEntitiesAllowlistCache(userId);
      } catch (error) {
        this.logger.warn(
          {
            userId,
            chatIds: unsupportedChatIds,
            code:
              error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code
                : ((error as { code?: string } | null)?.code ?? null),
            err: error,
          },
          isPrismaKnownError(error, 'P2024')
            ? 'Skipped managed entities allowlist cleanup because the Prisma pool is saturated'
            : 'Failed to clean unsupported managed entities from allowlist',
        );
      }
    }

    const supportedChats = chats.filter(
      (chat) => !isUnsupportedManagedChat(chat.id, chat.entityType),
    );
    const strictVisibleChats = await this.filterManagedEntitiesByStrictAccessEdges(
      userId,
      supportedChats,
    );
    const repairedChats = await this.repairManagedEntityAccessEdgesFromAllowlist(
      userId,
      supportedChats,
      strictVisibleChats,
    );
    const visibleChats = this.filterManagedEntitiesByVisibleIdsInSourceOrder(
      supportedChats,
      strictVisibleChats,
      repairedChats,
    );
    this.rememberManagedEntitiesLastSuccessChats(userId, visibleChats);

    return visibleChats;
  }

  private async repairManagedEntityAccessEdgesFromAllowlist(
    userId: string,
    candidates: readonly ChatSummary[],
    visibleChats: readonly ChatSummary[],
  ): Promise<ChatSummary[]> {
    if (candidates.length === 0) {
      return [];
    }

    const visibleChatIds = new Set(visibleChats.map((chat) => chat.id));
    const missingEdgeCandidates = candidates.filter((chat) => !visibleChatIds.has(chat.id));
    if (missingEdgeCandidates.length === 0) {
      return [];
    }

    if (!this.maxChatAdminRosterSyncService) {
      return [];
    }

    const allowlistedChats = await this.findAllowlistedManagedEntityRepairChats(
      userId,
      missingEdgeCandidates,
    );
    if (allowlistedChats.size === 0) {
      return [];
    }

    const baseRepairCandidates = missingEdgeCandidates
      .map((chat) => {
        const allowlistedAt = allowlistedChats.get(chat.id);
        if (!allowlistedAt) {
          return null;
        }
        const botIds = this.resolveManagedEntityAccessRepairBotIds(chat);

        return { chat, botIds, allowlistedAt };
      })
      .filter(
        (candidate): candidate is { chat: ChatSummary; botIds: string[]; allowlistedAt: Date } =>
          candidate !== null,
      );
    const repairCandidates = await this.attachActiveManagedEntityRepairBotIds(baseRepairCandidates);
    if (repairCandidates.length === 0) {
      return [];
    }

    for (const { chat, botIds } of repairCandidates) {
      void this.maxChatAdminRosterSyncService
        .scheduleChatAdminRosterSync({
          chatId: chat.id,
          botIds,
          title: chat.title,
          entityType: chat.entityType,
          source: 'admin_access_validation',
        })
        .catch((error: unknown) => {
          this.logger.warn(
            {
              chatId: chat.id,
              entityType: chat.entityType,
              userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to enqueue managed entity access edge repair from allowlist',
          );
        });
    }

    return [];
  }

  private async findAllowlistedManagedEntityRepairChats(
    userId: string,
    candidates: readonly ChatSummary[],
  ): Promise<Map<string, Date>> {
    const chatIds = Array.from(
      new Set(candidates.map((chat) => chat.id.trim()).filter((chatId) => chatId.length > 0)),
    );
    if (chatIds.length === 0) {
      return new Map();
    }

    try {
      const rows = await this.prisma.chatAdminAllowlist.findMany({
        where: {
          userId,
          chatId: {
            in: chatIds,
          },
        },
        select: {
          chatId: true,
          createdAt: true,
        },
      });
      const allowlistedChats = new Map<string, Date>();
      for (const row of rows as Array<{ chatId: string; createdAt: Date }>) {
        const chatId = row.chatId.trim();
        if (chatId.length > 0) {
          allowlistedChats.set(chatId, row.createdAt);
        }
      }
      return allowlistedChats;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          requestedItems: chatIds.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to confirm allowlist rows for managed entity access edge repair',
      );
      return new Map();
    }
  }

  private async attachActiveManagedEntityRepairBotIds(
    candidates: ReadonlyArray<{
      chat: ChatSummary;
      botIds: string[];
      allowlistedAt: Date;
    }>,
  ): Promise<Array<{ chat: ChatSummary; botIds: string[]; allowlistedAt: Date }>> {
    if (candidates.length === 0) {
      return [];
    }

    const memberships = (this.prisma as unknown as { chatBotMembership?: unknown })
      .chatBotMembership;
    if (!memberships || typeof memberships !== 'object') {
      return [...candidates];
    }

    const membershipClient = memberships as {
      findMany?: (args: unknown) => Promise<Array<{ chatId: string; botId: string }>>;
    };
    if (typeof membershipClient.findMany !== 'function') {
      return [...candidates];
    }

    const chatIds = Array.from(
      new Set(candidates.map((candidate) => candidate.chat.id.trim()).filter(Boolean)),
    );
    if (chatIds.length === 0) {
      return [...candidates];
    }

    const runtimeBotIds = [...this.managedEntitiesRuntimeBotIds];
    try {
      const rows = await membershipClient.findMany({
        where: {
          chatId: {
            in: chatIds,
          },
          ...(runtimeBotIds.length > 0
            ? {
                botId: {
                  in: runtimeBotIds,
                },
              }
            : {}),
          status: ChatBotMembershipStatus.ACTIVE,
        },
        select: {
          chatId: true,
          botId: true,
        },
      });
      const activeBotIdsByChatId = new Map<string, string[]>();
      for (const row of rows) {
        const chatId = this.readTrimmedString(row.chatId);
        const botId = this.normalizeManagedEntityAccessBotId(row.botId);
        if (!chatId || !botId || !this.isManagedEntityAccessBotInRuntimeScope(botId)) {
          continue;
        }

        activeBotIdsByChatId.set(chatId, [...(activeBotIdsByChatId.get(chatId) ?? []), botId]);
      }

      return candidates.map((candidate) => {
        const activeBotIds = activeBotIdsByChatId.get(candidate.chat.id) ?? [];
        return {
          ...candidate,
          botIds: Array.from(new Set([...activeBotIds, ...candidate.botIds])),
        };
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          requestedItems: candidates.length,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read active bot memberships for managed entity allowlist repair',
      );
      return [...candidates];
    }
  }

  private buildManagedEntityRepairEdgeKey(chatId: string, botId: string): string {
    return `${chatId}:${botId}`;
  }

  private async attachChannelOverview(chats: ChatSummary[]): Promise<ChatSummary[]> {
    const channelIds = chats.filter((chat) => chat.entityType === 'channel').map((chat) => chat.id);

    if (channelIds.length === 0 || typeof this.prisma.channelSettings?.findMany !== 'function') {
      return chats;
    }

    try {
      const rows = await this.prisma.channelSettings.findMany({
        where: {
          chatId: {
            in: channelIds,
          },
        },
        select: {
          chatId: true,
          commentsEnabled: true,
          postSuggestionsEnabled: true,
          commentsModerationEnabled: true,
        },
      });

      const byChatId = new Map(
        rows.map((row) => [
          row.chatId,
          {
            commentsEnabled: row.commentsEnabled,
            postSuggestionsEnabled: row.postSuggestionsEnabled,
            commentsModerationEnabled: row.commentsModerationEnabled,
          },
        ]),
      );

      return chats.map((chat) => {
        if (chat.entityType !== 'channel') {
          return chat;
        }

        const settings = byChatId.get(chat.id) ?? DEFAULT_CHANNEL_SETTINGS;
        return {
          ...chat,
          channelOverview: buildChannelOverview(settings),
        };
      });
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to attach channel overview to managed entities list',
      );
      return chats;
    }
  }

  private async attachManagedEntityAvatars(
    chats: ChatSummary[],
    _options: {
      remoteChats?: readonly MaxBotChat[];
    } = {},
  ): Promise<ChatSummary[]> {
    if (chats.length === 0) {
      return chats;
    }

    const headersByChatId = new Map<string, ManagedEntityHeader>();

    const headers = this.chatContextCache.getManagedEntityHeaders
      ? await this.chatContextCache.getManagedEntityHeaders(chats)
      : await mapWithConcurrencyLimit(chats, 8, (chat) =>
          this.chatContextCache.getManagedEntityHeader?.(chat.id, chat.entityType),
        );
    for (const header of headers) if (header) headersByChatId.set(header.id, header);

    if (headersByChatId.size === 0) {
      return chats;
    }

    return chats.map((chat) => {
      const header = headersByChatId.get(chat.id);
      if (!header) {
        return chat;
      }

      const title =
        resolvePresentableManagedEntityTitle(
          chat.id,
          this.readTrimmedString(header.title),
          chat.title,
        ) ?? chat.title;
      const link = this.readTrimmedString(header.link) ?? chat.link ?? null;
      if (
        chat.metadataObservedAt &&
        (!header.metadataObservedAt || header.metadataObservedAt < chat.metadataObservedAt)
      )
        return chat;
      const avatarUrl = this.readTrimmedString(header.avatarUrl);

      return {
        ...chat,
        title,
        link,
        ...(avatarUrl ? { avatarUrl } : header.avatarState === 'absent' ? { avatarUrl: null } : {}),
        ...(header.avatarState ? { avatarState: header.avatarState } : {}),
        ...(header.metadataObservedAt ? { metadataObservedAt: header.metadataObservedAt } : {}),
      };
    });
  }

  private async primeManagedEntityHeaders(
    chats: ChatSummary[],
    remoteChats: readonly MaxBotChat[],
  ): Promise<void> {
    if (
      !Array.isArray(remoteChats) ||
      remoteChats.length === 0 ||
      typeof this.chatContextCache.setManagedEntityHeader !== 'function'
    ) {
      return;
    }

    const remoteByChatId = new Map(remoteChats.map((chat) => [chat.chatId, chat]));
    await Promise.all(
      chats.map(async (chat) => {
        const remoteChat = remoteByChatId.get(chat.id);
        if (!remoteChat) {
          return;
        }

        const presentableTitle = resolvePresentableManagedEntityTitle(
          chat.id,
          remoteChat.title,
          chat.title,
        );
        const title = presentableTitle ?? chat.title;
        const link = remoteChat.link ?? chat.link ?? null;
        const avatarUrl =
          this.readTrimmedString(remoteChat.avatarUrl) ?? this.readTrimmedString(chat.avatarUrl);

        if (link === null && avatarUrl === null && title === chat.title) {
          return;
        }

        if (presentableTitle && presentableTitle !== chat.title) {
          try {
            await this.prisma.chat.update({
              where: { id: chat.id },
              data: { title: presentableTitle },
            });
          } catch (error: unknown) {
            this.logger.warn(
              {
                chatId: chat.id,
                err: error instanceof Error ? error.message : String(error),
              },
              'Failed to persist discovered managed entity title',
            );
          }
        }

        await this.chatContextCache.setManagedEntityHeader(
          createManagedEntityHeader({
            id: chat.id,
            title,
            entityType: chat.entityType,
            link,
            participantsCount: null,
            avatarUrl,
            primaryBotId: chat.primaryBotId,
            assignedBots: chat.assignedBots,
            sharedMode: chat.sharedMode,
          }),
        );
      }),
    );
  }

  private async hydrateManagedEntities(
    chats: ChatSummary[],
    options: {
      remoteChats?: readonly MaxBotChat[];
    } = {},
  ): Promise<ChatSummary[]> {
    if (Array.isArray(options.remoteChats) && options.remoteChats.length > 0) {
      await this.primeManagedEntityHeaders(chats, options.remoteChats);
    }
    const withAvatars = await this.attachManagedEntityAvatars(chats, options);
    return this.attachChannelOverview(withAvatars);
  }

  private scheduleManagedEntityHeaderHydration(
    userId: string,
    entityType: ManagedEntityTypeFilter,
    chats: ChatSummary[],
    options: {
      remoteChats?: readonly MaxBotChat[];
      deferStart?: boolean;
    } = {},
  ) {
    if (chats.length === 0) {
      return;
    }

    const key = this.buildManagedEntitiesRefreshCooldownKey(userId, entityType);
    if (this.managedEntityHeaderHydrationRuns.has(key)) {
      return;
    }

    // FLAG: Old clients warm only a bounded first screen. Visible-card demand owns
    // later rows; both paths use the same durable queue and per-entity deduplication.
    const pending = (async () => {
      if (options.remoteChats?.length)
        await this.primeManagedEntityHeaders(chats, options.remoteChats);
      for (const type of ['chat', 'channel'] as const) {
        const entityIds = chats
          .filter((chat) => chat.entityType === type)
          .slice(0, 8)
          .map((chat) => chat.id);
        if (entityIds.length)
          await this.entityPresentation?.readForUser(userId, { entityType: type, entityIds });
      }
    })()
      .catch((error: unknown) => {
        this.logger.warn(
          { entityType, err: error instanceof Error ? error.message : String(error) },
          'Managed entity presentation admission failed',
        );
      })
      .finally(() => this.managedEntityHeaderHydrationRuns.delete(key));
    this.managedEntityHeaderHydrationRuns.set(key, pending);
  }

  private toHeaderChatSummary(header: ManagedEntityHeader): ChatSummary {
    return this.createManagedEntitySummary({
      id: header.id,
      title: header.title,
      createdAt: new Date(0).toISOString(),
      entityType: header.entityType,
      link: header.link,
      avatarUrl: this.readTrimmedString(header.avatarUrl) ?? null,
      primaryBotId: header.primaryBotId,
      assignedBots: header.assignedBots,
      sharedMode: header.sharedMode,
    });
  }

  private async persistManagedEntityHeaderSnapshot(
    chat: ChatSummary,
    snapshot: {
      title: string | null;
      link: string | null;
      participantsCount: number | null;
      avatarUrl: string | null;
    },
  ): Promise<void> {
    const title =
      resolvePresentableManagedEntityTitle(chat.id, snapshot.title, chat.title) ?? chat.title;
    const avatarUrl = this.readTrimmedString(snapshot.avatarUrl);
    const link = this.readTrimmedString(snapshot.link) ?? chat.link ?? null;

    if (!isFallbackTitle(chat.id, title) && title !== chat.title) {
      try {
        await this.prisma.chat.update({
          where: { id: chat.id },
          data: { title },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: chat.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to persist refreshed managed entity title',
        );
      }
    }

    await this.chatContextCache.setManagedEntityHeader?.(
      createManagedEntityHeader({
        id: chat.id,
        title,
        entityType: chat.entityType,
        link,
        participantsCount: snapshot.participantsCount ?? null,
        avatarUrl,
        primaryBotId: chat.primaryBotId,
        assignedBots: chat.assignedBots,
        sharedMode: chat.sharedMode,
      }),
    );
  }

  private async upsertUserChatAccess(
    chatId: string,
    userId: string,
    chatTitle: string | null,
    entityType: ManagedEntityType | null = null,
    options: {
      updateEntityType?: boolean;
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
      titleUpdateMode?: 'always' | 'fallback_only';
      accessProbeStartedAt?: Date;
    } = {},
  ) {
    const normalizedTitle = chatTitle?.trim() ? chatTitle.trim() : null;
    const fallbackTitle = entityType === 'channel' ? `Channel ${chatId}` : `Chat ${chatId}`;
    const presentableTitle = resolvePresentableManagedEntityTitle(chatId, normalizedTitle);
    const nextTitle = presentableTitle ?? fallbackTitle;
    const updateEntityType = options.updateEntityType === true;
    const titleUpdateMode =
      options.titleUpdateMode === 'fallback_only' ? 'fallback_only' : 'always';
    const observedBotIds = Array.from(
      new Set(
        (options.observedBotIds ?? [])
          .map((botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null)
          .filter((botId): botId is string => Boolean(botId)),
      ),
    );
    let shouldUpdateTitle = false;
    if (presentableTitle) {
      if (titleUpdateMode === 'always') {
        shouldUpdateTitle = true;
      } else {
        const existing = await this.prisma.chat.findUnique({
          where: { id: chatId },
          select: { title: true },
        });
        const existingTitle = this.readTrimmedString(existing?.title);
        shouldUpdateTitle =
          !existingTitle || existingTitle === chatId || isFallbackTitle(chatId, existingTitle);
      }
    }
    let resolvedBotId: string | null | undefined =
      this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? observedBotIds[0] ?? null;
    if (!resolvedBotId) {
      try {
        resolvedBotId = (await this.resolveBotAssignment(chatId)) ?? undefined;
      } catch (error: unknown) {
        if (!isPrismaKnownError(error, 'P2024')) {
          throw error;
        }

        this.logger.warn(
          {
            chatId,
            userId,
            code:
              error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code
                : ((error as { code?: string } | null)?.code ?? null),
            err: error instanceof Error ? error.message : String(error),
          },
          'Skipped bot assignment lookup while persisting managed entity access because the Prisma pool is saturated',
        );
      }
    }
    const chatWrite = {
      where: { id: chatId },
      create: {
        id: chatId,
        title: nextTitle,
        ...this.buildResolvedBotAssignmentData(resolvedBotId),
        ...(entityType ? { entityType: toPrismaEntityType(entityType) } : {}),
      },
      update: {
        ...(shouldUpdateTitle
          ? {
              title: nextTitle,
            }
          : {}),
        ...(updateEntityType && entityType ? { entityType: toPrismaEntityType(entityType) } : {}),
      },
    } satisfies Prisma.ChatUpsertArgs;
    const allowlistWrite = {
      where: {
        chatId_userId: {
          chatId,
          userId,
        },
      },
      create: {
        chatId,
        userId,
      },
      update: {},
    } satisfies Prisma.ChatAdminAllowlistUpsertArgs;
    const persistedChat = options.accessProbeStartedAt
      ? await this.prisma.$transaction(async (tx) => {
          const chat = await tx.chat.upsert(chatWrite);
          if (
            !(await this.managedEntityAccessRuntime.lockRemoteAdminAccessProbe(
              tx,
              chatId,
              userId,
              options.accessProbeStartedAt as Date,
            ))
          ) {
            return null;
          }
          await tx.chatAdminAllowlist.upsert(allowlistWrite).catch(ignorePrismaUniqueConflict);
          return chat;
        })
      : await this.prisma.chat.upsert(chatWrite).then(async (chat) => {
          await this.prisma.chatAdminAllowlist
            .upsert(allowlistWrite)
            .catch(ignorePrismaUniqueConflict);
          return chat;
        });
    if (!persistedChat) {
      return null;
    }
    this.invalidateManagedEntitiesAllowlistCache(userId);

    if (typeof this.maxBotLinkService?.bindDiscoveredChatBots === 'function') {
      try {
        await this.maxBotLinkService.bindDiscoveredChatBots({
          chatId,
          primaryBotId: resolvedBotId,
          botIds: resolvedBotId ? [resolvedBotId, ...observedBotIds] : observedBotIds,
          title: persistedChat.title,
          entityType: entityType ? toPrismaEntityType(entityType) : null,
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            code:
              error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code
                : ((error as { code?: string } | null)?.code ?? null),
            err: error instanceof Error ? error.message : String(error),
          },
          isPrismaKnownError(error, 'P2024')
            ? 'Skipped discovered chat bot binding because the Prisma pool is saturated'
            : 'Failed to bind discovered chat bots after persisting managed entity access',
        );
      }
    }

    if (shouldUpdateTitle || updateEntityType) {
      await this.chatContextCache.invalidateManagedEntityHeader?.(chatId);
    }

    return persistedChat;
  }

  private async ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void> {
    const current = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
      },
    });

    if (current) {
      if (fromPrismaEntityType(current.entityType) === expectedEntityType) {
        return;
      }

      try {
        const resolvedBotId = await this.resolveBotAssignment(chatId);
        const snapshot = await this.maxClient.getChatSnapshot(chatId, {
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
          ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        });
        if (snapshot.entityType === expectedEntityType) {
          await this.upsertUserChatAccess(chatId, userId, snapshot.title, expectedEntityType, {
            updateEntityType: true,
            titleUpdateMode: 'fallback_only',
            preferredBotId: resolvedBotId ?? null,
          });
          return;
        }
      } catch (error: unknown) {
        if (error instanceof BadRequestException) {
          throw error;
        }
      }

      throw new BadRequestException(
        expectedEntityType === 'channel'
          ? 'Этот ID относится к чату, а не к каналу.'
          : 'Этот ID относится к каналу, а не к чату.',
      );
    }

    try {
      const resolvedBotId = await this.resolveBotAssignment(chatId);
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      });
      if (snapshot.entityType !== expectedEntityType) {
        throw new BadRequestException(
          expectedEntityType === 'channel'
            ? 'Этот ID относится к чату, а не к каналу.'
            : 'Этот ID относится к каналу, а не к чату.',
        );
      }
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
    }

    await this.upsertUserChatAccess(chatId, userId, null, expectedEntityType);
  }

  private async getManagedEntityHeader(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedEntityHeader> {
    if (entityType === 'channel') {
      return this.managedEntitiesRuntime.getChannelHeader(chatId, user, options);
    }

    return this.managedEntitiesRuntime.getChatHeader(chatId, user, options);
  }

  private invalidateLogsDashboardResponseCache(chatId: string): void {
    this.logsDashboardRuntime.invalidateLogsDashboardResponseCache(chatId);
  }

  private invalidateChannelStatsResponseCache(chatId: string): void {
    this.channelStatsRuntime.invalidateChannelStatsResponseCache(chatId);
  }

  private invalidateModerationFeedPageCache(chatId: string): void {
    this.logsDashboardRuntime.invalidateModerationFeedPageCache(chatId);
  }

  private invalidateChatParticipantsPageCache(chatId: string): void {
    this.participantsRuntime.invalidateChatParticipantsPageCache(chatId);
  }
}
