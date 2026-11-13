import { SuggestionReviewService } from './suggestion-review.service';
import { SuggestionReviewController } from './suggestion-review.controller';
import { SuggestionReviewEffectsService } from './suggestion-review-effects.service';
import { SuggestionReviewEffectsRecoveryService } from './suggestion-review-effects-recovery.service';
import { MarketplaceEditorialService } from '../integrations/marketplace/marketplace-editorial.service';
import { MarketplaceEditorialAccessService } from '../integrations/marketplace/marketplace-editorial-access.service';
import {
  MarketplaceEditorialController,
  MarketplaceEditorialIntegrationController,
} from '../integrations/marketplace/marketplace-editorial.controller';
import { StatsModule } from '../statistics/stats.module';
import { OcrReadinessStateModule } from '../health/ocr-readiness-state.module';
import { StatisticsExchangeV3Controller } from '../integrations/marketplace/statistics-exchange-v3.controller';
import { StatisticsExchangeV3MembershipService } from '../integrations/marketplace/statistics-exchange-v3-membership.service';
import { StatisticsExchangeV3Service } from '../integrations/marketplace/statistics-exchange-v3.service';
import { StatisticsExchangeV3ConsumerService } from '../integrations/marketplace/statistics-exchange-v3-consumer.service';
import { MarketplaceStateModule } from '../integrations/marketplace/marketplace-state.module';
import {
  StatisticsExchangeController,
  StatisticsExchangeOwnerController,
} from '../integrations/marketplace/statistics-exchange.controller';
import { StatisticsExchangeGrantsService } from '../integrations/marketplace/statistics-exchange-grants.service';
import { StatisticsExchangeDownloadsService } from '../integrations/marketplace/statistics-exchange-downloads.service';
import { StatisticsExchangeStatisticsService } from '../integrations/marketplace/statistics-exchange-statistics.service';
import { StatisticsExchangeAudienceService } from '../integrations/marketplace/statistics-exchange-audience.service';
import { StatisticsExchangeRuntimeService } from '../integrations/marketplace/statistics-exchange-runtime.service';
import {
  MARKETPLACE_PUBLISHER_ACCESS_QUEUE,
  MarketplacePublisherAccessQueueService,
} from '../integrations/marketplace/marketplace-publisher-access.queue';
import { MarketplacePublisherAccessProcessor } from '../integrations/marketplace/marketplace-publisher-access.processor';
import { MarketplaceAccessService } from '../integrations/marketplace/marketplace-access.service';
import { StatisticsAccessDemandService } from '../integrations/marketplace/statistics-access-demand.service';
import { MarketplaceNavigationService } from '../integrations/marketplace/marketplace-navigation.service';
import { MarketplaceNavigationController } from '../integrations/marketplace/marketplace.controller';
import { MarketplaceProfileAccessService } from '../integrations/marketplace/marketplace-profile-access.service';
import { MarketplaceButtonPolicyService } from '../integrations/marketplace/marketplace-button-policy.service';
import { MarketplaceProfileService } from '../integrations/marketplace/marketplace-profile.service';
import { MarketplaceStatisticsService } from '../integrations/marketplace/marketplace-statistics.service';
import { MarketplaceNativeProjectionService } from '../integrations/marketplace/marketplace-native-projection.service';
import { MarketplaceCollectorService } from '../integrations/marketplace/marketplace-collector.service';
import { MarketplaceRuntimeService } from '../integrations/marketplace/marketplace-runtime.service';
import { MarketplaceIntegrationGuard } from '../integrations/marketplace/marketplace-integration.guard';
import {
  MarketplaceIntegrationController,
  MarketplaceProfileController,
} from '../integrations/marketplace/marketplace.controller';
import { registerRuntimeQueues } from '../runtime/runtime-queues';
import { SuggestionSubscriptionModule } from '../suggestions/suggestion-subscription.module';
import { SuggestionSubscriptionMonitorService } from './suggestion-subscription-monitor.service';
import { Module } from '@nestjs/common';
import { ReportsModule } from '../moderation/reports/reports.module';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsService } from './admin-reports.service';
import { AuthModule } from '../auth/auth.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { RedisCounterModule } from '../moderation/redis-counter.module';
import { PublisherModule } from '../publisher/publisher.module';
import { PUBLISHER_SUGGESTION_ADMIN_QUEUE } from '../publisher/publisher-suggestion-admin.queue';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { NightModeTransitionModule } from '../moderation/night-mode-transition.module';
import { ModerationDeleteIntentModule } from '../moderation/moderation-delete-intent.module';
import { MessageDuplicateStateModule } from '../moderation/message-duplicate/message-duplicate-state.module';
import { getAppRole, roleRunsAction, roleRunsPublisher } from '../runtime/app-role';
import { SystemModule } from '../system/system.module';
import { AdminManagedEntitiesRefreshProcessor } from './admin-managed-entities-refresh.processor';
import { ManagedEntityPresentationController } from './managed-entity-presentation.controller';
import { ManagedEntityPresentationService } from './managed-entity-presentation.service';
import { ManagedEntityNetworksController } from './managed-entity-networks.controller';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';
import { NetworkSettingsMetadataService } from './network-settings-metadata.service';
import { NetworkNavigationAllowlist } from './network-navigation-allowlist';
import { NetworkAuthorizationService } from './network-authorization.service';
import { NetworkSettingsController } from './network-settings.controller';
import { MajorNetworksGuard } from './major-networks.guard';
import { NetworkSettingsService } from './network-settings.service';
import { NetworkSettingsRunnerService } from './network-settings-runner.service';
import { NetworkStatisticsController } from './network-statistics.controller';
import { NetworkStatisticsService } from './network-statistics.service';
import { NetworkStatisticsObservationService } from './network-statistics-observation.service';
import { ManagedModeratorController } from './managed-moderator.controller';
import { ManagedModeratorService } from './managed-moderator.service';
import { MaxFixedModeratorAssignmentService } from '../max/max-fixed-moderator-assignment.service';
import { ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE } from './admin-managed-entities-refresh.queue';
import { AdminManualFanoutProcessor } from './admin-manual-fanout.processor';
import { ADMIN_MANUAL_FANOUT_QUEUE } from './admin-manual-fanout.queue';
import { AdminManualCommandProcessor } from './admin-manual-command.processor';
import { ADMIN_MANUAL_COMMAND_QUEUE } from './admin-manual-command.queue';
import { AdminManualMessageCleanupService } from './admin-manual-message-cleanup.service';
import { AdminSuggestionDeliveryProcessor } from './admin-suggestion-delivery.processor';
import { ADMIN_SUGGESTION_DELIVERY_QUEUE } from './admin-suggestion-delivery.queue';
import { AdminSuggestionDeliveryRecoveryService } from './admin-suggestion-delivery-recovery.service';
import { AdminSuperBanProcessor } from './admin-super-ban.processor';
import { ADMIN_SUPER_BAN_QUEUE } from './admin-super-ban.queue';
import { AdminDialogController } from './admin-dialog.controller';
import { AdminGiveawayController } from './admin-giveaway.controller';
import { AdminManualModerationController } from './admin-manual-moderation.controller';
import { AdminPollController } from './admin-poll.controller';
import { AdminDialogLinkService } from './admin-dialog-link.service';
import { AdminSettingsService } from './admin-settings.service';
import { AdminStopWordsService } from './admin-stop-words.service';
import { AdminStopWordsController } from './admin-stop-words.controller';
import { AdminLinksController } from './admin-links.controller';
import { AdminLinksService } from './admin-links.service';
import { AdminCommercialAdsController } from './admin-commercial-ads.controller';
import { AdminCommercialAdsService } from './admin-commercial-ads.service';
import { CommercialAdsPreviewService } from '../moderation/commercial/commercial-ads-preview.service';
import { AdminMessageRetentionController } from './admin-message-retention.controller';
import { AdminMessageRetentionService } from './admin-message-retention.service';
import { EraserControlService } from '../message-retention/eraser-control.service';
import { MessageRetentionStateModule } from '../message-retention/message-retention-state.module';
import { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';
import { AdminDuplicateDiagnosticsService } from './admin-duplicate-diagnostics.service';
import { AdminManagedEntitiesController } from './admin-managed-entities.controller';
import { AdvertisingPlacementController } from './advertising-placement.controller';
import { AdvertisingPlacementService } from './advertising-placement.service';
import { AdminSettingsController } from './admin-settings.controller';
import { PublisherVkParsingController } from './publisher-vk-parsing.controller';
import { PublisherVkBotReviewController } from './publisher-vk-bot-review.controller';
import { VkBotReviewService } from './vk-bot-review.service';
import { ChannelDialogService } from './channel-dialog.service';
import { CommentModerationService } from './comment-moderation.service';
import { CommentModerationController } from './comment-moderation.controller';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import { CHANNEL_DIALOG_LEGACY_PORT } from './channel-dialog-legacy.port';
import { ManualModerationService } from './manual-moderation.service';
import { ChatSanctionsService } from './chat-sanctions.service';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedAutopostService } from './managed-autopost.service';
import { ManagedEntityCandidateSyncService } from './managed-entity-candidate-sync.service';
import { ManagedEntitiesDiscoveryService } from './managed-entities-discovery.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { ManagedEntityAccessRefreshService } from './managed-entity-access-refresh.service';
import { PublisherSelectedAccessService } from './publisher-selected-access.service';
import { MANAGED_ENTITIES_LEGACY_PORT } from './managed-entities-legacy.port';
import { ManagedGiveawayRunnerService } from './managed-giveaway-runner.service';
import { ManagedGiveawayService } from './managed-giveaway.service';
import { ManagedPollService } from './managed-poll.service';
import { ManagedPollRunnerService } from './managed-poll-runner.service';
import { PublicationController } from './publication.controller';
import { PublicationContentService } from './publication-content.service';
import { PublicationMetricsInterceptor } from './publication-metrics.interceptor';
import { PublicationPresenterService } from './publication-presenter.service';
import { PublicationPublisherTargetRefreshService } from './publication-publisher-target-refresh.service';
import { PublicationRunnerService } from './publication-runner.service';
import { PublicationService } from './publication.service';
import { PublicationPostActionCommandsService } from './publication-post-action-commands.service';
import { PublicationPostActionsController } from './publication-post-actions.controller';
import { PublicationDraftsController } from './publication-drafts.controller';
import { PublicationDraftsService } from './publication-drafts.service';
import { PublicationAssetsController } from './publication-assets.controller';
import { PublicationVideoUploadsController } from './publication-video-uploads.controller';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublisherDialogContextService } from './publisher-dialog-context.service';
import { PublisherPublicationDispatchRunnerService } from './publisher-publication-dispatch-runner.service';
import { PublisherPublicationWakeupProcessor } from './publisher-publication-wakeup.processor';
import {
  PUBLISHER_PUBLICATION_WAKEUP_QUEUE,
  PublisherPublicationWakeupQueueService,
} from './publisher-publication-wakeup.queue';
import { AdminService } from './admin.service';
import { ChannelStatsCollectorService } from './channel-stats-collector.service';
import { VkParsingPublisherProcessor } from './vk-parsing-publisher.processor';
import { VkParsingRunnerService } from './vk-parsing-runner.service';
import { VkParsingSyncProcessor } from './vk-parsing-sync.processor';
import { VK_PARSING_PUBLISHER_QUEUE, VK_PARSING_SYNC_QUEUE } from './vk-parsing.queue';
import { VkApiClientService } from './vk-api-client.service';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import { VkParsingMediaCacheService } from './vk-parsing-media-cache.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import { VkParsingPostImportRepository } from './vk-parsing-post-import.repository';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';
import { VkParsingService } from './vk-parsing.service';
import { VkPublishService } from './vk-publish.service';
import { VkSourceService } from './vk-source.service';
import { VkSyncService } from './vk-sync.service';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SafetyDeskRetentionController } from './safety-desk-retention.controller';
import { SafetyDeskRetentionService } from './safety-desk-retention.service';
import { SafetyDeskController } from './safety-desk.controller';
import { SafetyDeskService } from './safety-desk.service';
import { SafetyDeskObservabilityController } from './safety-desk-observability.controller';
import { SafetyDeskCommercialAiService } from './safety-desk-commercial-ai.service';
import { SafetyDeskCommercialAiPoolService } from './safety-desk-commercial-ai-pool.service';
import { SafetyDeskOverviewService } from './safety-desk-overview.service';
import { RuntimeOverviewReaderController } from './runtime-overview-reader.controller';
import { RuntimeOverviewReaderGuard } from './runtime-overview-reader.guard';
import { SafetyDeskOverviewStore } from './safety-desk-overview-store';
import { SafetyDeskOverviewPendingService } from './safety-desk-overview-pending.service';
import { SafetyDeskOverviewActionsService } from './safety-desk-overview-actions.service';
import { SafetyDeskWebhookCohortService } from './safety-desk-webhook-cohort.service';
import { SafetyDeskDeleteEvidenceService } from './safety-desk-delete-evidence.service';
import { SafetyDeskPublicationCohortService } from './safety-desk-publication-cohort.service';
import { SafetyDeskDeleteCohortService } from './safety-desk-delete-cohort.service';
import { SafetyDeskPublicationDeliveryCohortService } from './safety-desk-publication-delivery-cohort.service';
import { SafetyDeskPublicationDeliveryEvidenceService } from './safety-desk-publication-delivery-evidence.service';
import { SupportRequestsController } from './support-requests.controller';
import { SupportRequestsService } from './support-requests.service';
import { PublisherController } from './publisher.controller';
import { PublisherEntityRefreshService } from './publisher-entity-refresh.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { PublisherCatalogQueryService } from './publisher-catalog-query.service';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import { PublisherAutoReplyService } from './publisher-auto-reply.service';
import { PublisherSuggestionPublicationQueueService } from './publisher-suggestion-publication-queue.service';
import { PublisherSuggestionPublicationProcessor } from './publisher-suggestion-publication.processor';
import { PUBLISHER_SUGGESTION_PUBLICATION_QUEUE } from './publisher-suggestion-publication.queue';
import { PublisherSuggestionAdminProcessor } from './publisher-suggestion-admin.processor';
import { PublisherSuggestionAdminRecoveryService } from './publisher-suggestion-admin-recovery.service';
import { PublisherPostImportProcessingService } from './publisher-post-import-processing.service';
import { PublisherPostImportDeliveryService } from './publisher-post-import-delivery.service';
import { PublisherPostImportProcessor } from './publisher-post-import.processor';
import { PublisherAutoReplyAuthoringProcessingService } from './publisher-auto-reply-authoring-processing.service';
import { PublisherAutoReplyAuthoringDeliveryService } from './publisher-auto-reply-authoring-delivery.service';
import { PublisherAutoReplyAuthoringProcessor } from './publisher-auto-reply-authoring.processor';

@Module({
  imports: [
    StatsModule,
    OcrReadinessStateModule,
    SuggestionSubscriptionModule,
    MessageRetentionStateModule,
    ...registerRuntimeQueues(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE),
    ...registerRuntimeQueues(ADMIN_MANUAL_FANOUT_QUEUE),
    ...registerRuntimeQueues(ADMIN_MANUAL_COMMAND_QUEUE),
    ...registerRuntimeQueues(ADMIN_SUPER_BAN_QUEUE),
    ...registerRuntimeQueues(ADMIN_SUGGESTION_DELIVERY_QUEUE),
    ...registerRuntimeQueues(VK_PARSING_SYNC_QUEUE),
    ...registerRuntimeQueues(VK_PARSING_PUBLISHER_QUEUE),
    ...registerRuntimeQueues(PUBLISHER_SUGGESTION_PUBLICATION_QUEUE),
    ...registerRuntimeQueues(PUBLISHER_SUGGESTION_ADMIN_QUEUE),
    ...registerRuntimeQueues(PUBLISHER_PUBLICATION_WAKEUP_QUEUE),
    AuthModule,
    MarketplaceStateModule,
    ...registerRuntimeQueues(MARKETPLACE_PUBLISHER_ACCESS_QUEUE),
    ReportsModule,
    MaxModule,
    ChatContextModule,
    SystemModule,
    NightModeTransitionModule,
    ModerationDeleteIntentModule,
    MessageDuplicateStateModule,
    RedisCounterModule,
    PublisherModule,
  ],
  controllers: [
    SuggestionReviewController,
    AdminMessageRetentionController,
    AdminReportsController,
    AdvertisingPlacementController,
    MarketplaceIntegrationController,
    MarketplaceEditorialController,
    MarketplaceEditorialIntegrationController,
    StatisticsExchangeController,
    StatisticsExchangeV3Controller,
    StatisticsExchangeOwnerController,
    MarketplaceProfileController,
    MarketplaceNavigationController,
    AdminManagedEntitiesController,
    ManagedEntityPresentationController,
    ManagedEntityNetworksController,
    NetworkSettingsController,
    NetworkStatisticsController,
    ManagedModeratorController,
    AdminSettingsController,
    AdminStopWordsController,
    AdminLinksController,
    AdminCommercialAdsController,
    PublisherVkParsingController,
    PublisherVkBotReviewController,
    AdminDialogController,
    CommentModerationController,
    AdminGiveawayController,
    AdminPollController,
    AdminManualModerationController,
    PublicationController,
    PublicationPostActionsController,
    PublicationDraftsController,
    PublicationAssetsController,
    PublicationVideoUploadsController,
    PublisherController,
    SafetyDeskController,
    SafetyDeskRetentionController,
    SafetyDeskObservabilityController,
    RuntimeOverviewReaderController,
    SupportRequestsController,
  ],
  providers: [
    SuggestionReviewService,
    SuggestionReviewEffectsService,
    ...(roleRunsAction(getAppRole()) || roleRunsPublisher(getAppRole())
      ? [SuggestionReviewEffectsRecoveryService]
      : []),
    ...(roleRunsAction(getAppRole()) || roleRunsPublisher(getAppRole())
      ? [SuggestionSubscriptionMonitorService]
      : []),
    AdminMessageRetentionService,
    EraserControlService,
    AdminReportsService,
    AdvertisingPlacementService,
    MarketplaceAccessService,
    StatisticsAccessDemandService,
    MarketplacePublisherAccessQueueService,
    ...(roleRunsPublisher(getAppRole()) ? [MarketplacePublisherAccessProcessor] : []),
    MarketplaceProfileService,
    MarketplaceNavigationService,
    MarketplaceButtonPolicyService,
    MarketplaceProfileAccessService,
    MarketplaceEditorialService,
    MarketplaceEditorialAccessService,
    MarketplaceStatisticsService,
    MarketplaceCollectorService,
    MarketplaceNativeProjectionService,
    MarketplaceRuntimeService,
    StatisticsExchangeGrantsService,
    StatisticsExchangeV3MembershipService,
    StatisticsExchangeV3Service,
    StatisticsExchangeV3ConsumerService,
    StatisticsExchangeStatisticsService,
    StatisticsExchangeDownloadsService,
    StatisticsExchangeAudienceService,
    StatisticsExchangeRuntimeService,
    MarketplaceIntegrationGuard,
    AdminService,
    {
      provide: MANAGED_ENTITIES_LEGACY_PORT,
      useExisting: AdminService,
    },
    {
      provide: CHANNEL_DIALOG_LEGACY_PORT,
      useExisting: AdminService,
    },
    AdminManualMessageCleanupService,
    AdminDialogLinkService,
    AdminSettingsBotCapabilityService,
    AdminDuplicateDiagnosticsService,
    AdminSettingsService,
    AdminStopWordsService,
    AdminLinksService,
    AdminCommercialAdsService,
    CommercialAdsPreviewService,
    ChannelDialogService,
    CommentModerationService,
    ChannelPostSignatureService,
    ChannelStatsCollectorService,
    ManualModerationService,
    ChatSanctionsService,
    GlobalSpammerIntelligenceService,
    ManagedAutopostService,
    {
      provide: ManagedBroadcastService,
      useFactory: (adminService: AdminService) => new ManagedBroadcastService(adminService),
      inject: [AdminService],
    },
    ManagedEntityCandidateSyncService,
    ManagedEntitiesService,
    ManagedEntityPresentationService,
    ManagedEntityNetworksService,
    MajorNetworksGuard,
    NetworkAuthorizationService,
    NetworkNavigationAllowlist,
    NetworkSettingsMetadataService,
    NetworkSettingsService,
    NetworkStatisticsService,
    NetworkStatisticsObservationService,
    ...(roleRunsAction(getAppRole()) ? [NetworkSettingsRunnerService] : []),
    ManagedModeratorService,
    MaxFixedModeratorAssignmentService,
    ManagedEntityAccessRefreshService,
    PublisherSelectedAccessService,
    ManagedEntitiesDiscoveryService,
    ManagedGiveawayService,
    ManagedPollService,
    ManagedPollRunnerService,
    PublicationContentService,
    PublicationMetricsInterceptor,
    PublicationPresenterService,
    PublicationPublisherTargetRefreshService,
    PublicationService,
    PublicationPostActionCommandsService,
    PublicationDraftsService,
    PublicationPublisherRoutingService,
    PublisherDialogContextService,
    PublicationRunnerService,
    ...(roleRunsPublisher(getAppRole()) ? [PublisherPublicationDispatchRunnerService] : []),
    PublisherPublicationWakeupQueueService,
    ...(roleRunsPublisher(getAppRole()) ? [PublisherPublicationWakeupProcessor] : []),
    PublisherPolicyService,
    PublisherCatalogQueryService,
    PublisherSuggestionService,
    PublisherAutoReplyService,
    PublisherEntityRefreshService,
    PublisherSuggestionPublicationQueueService,
    ...(roleRunsPublisher(getAppRole()) ? [PublisherSuggestionPublicationProcessor] : []),
    ...(roleRunsPublisher(getAppRole())
      ? [PublisherSuggestionAdminProcessor, PublisherSuggestionAdminRecoveryService]
      : []),
    ...(roleRunsPublisher(getAppRole())
      ? [
          PublisherPostImportProcessingService,
          PublisherPostImportDeliveryService,
          PublisherPostImportProcessor,
          PublisherAutoReplyAuthoringProcessingService,
          PublisherAutoReplyAuthoringDeliveryService,
          PublisherAutoReplyAuthoringProcessor,
        ]
      : []),
    ManagedGiveawayRunnerService,
    VkParsingRateLimitService,
    VkApiClientService,
    VkParsingAccessService,
    VkParsingFeedService,
    VkSourceService,
    VkSyncService,
    VkPublishService,
    VkParsingMediaCacheService,
    VkParsingOwnershipService,
    VkParsingPostImportRepository,
    VkParsingService,
    VkBotReviewService,
    SafetyDeskAdminGuard,
    RuntimeOverviewReaderGuard,
    SafetyDeskService,
    SafetyDeskRetentionService,
    SafetyDeskCommercialAiService,
    SafetyDeskCommercialAiPoolService,
    SafetyDeskOverviewService,
    SafetyDeskOverviewStore,
    SafetyDeskOverviewPendingService,
    SafetyDeskOverviewActionsService,
    SafetyDeskWebhookCohortService,
    SafetyDeskDeleteEvidenceService,
    SafetyDeskPublicationCohortService,
    SafetyDeskDeleteCohortService,
    SafetyDeskPublicationDeliveryCohortService,
    SafetyDeskPublicationDeliveryEvidenceService,
    SupportRequestsService,
    ...(roleRunsPublisher(getAppRole()) ? [VkParsingRunnerService] : []),
    ...(roleRunsPublisher(getAppRole()) ? [VkParsingSyncProcessor] : []),
    ...(roleRunsPublisher(getAppRole()) ? [VkParsingPublisherProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManagedEntitiesRefreshProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManualFanoutProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminManualCommandProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuperBanProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuggestionDeliveryProcessor] : []),
    ...(roleRunsAction(getAppRole()) ? [AdminSuggestionDeliveryRecoveryService] : []),
  ],
  exports: [
    AdminService,
    AdminDialogLinkService,
    AdminSettingsService,
    ChannelDialogService,
    ChannelPostSignatureService,
    ManualModerationService,
    ManagedAutopostService,
    {
      provide: ManagedBroadcastService,
      useFactory: (adminService: AdminService) => new ManagedBroadcastService(adminService),
      inject: [AdminService],
    },
    ManagedEntityCandidateSyncService,
    ManagedEntitiesService,
    ManagedEntitiesDiscoveryService,
    ManagedGiveawayService,
    ManagedPollService,
    PublicationService,
    PublisherPolicyService,
    PublisherAutoReplyService,
    VkParsingRateLimitService,
    VkApiClientService,
    VkParsingAccessService,
    VkParsingFeedService,
    VkSourceService,
    VkSyncService,
    VkPublishService,
    VkParsingMediaCacheService,
    VkParsingOwnershipService,
    VkParsingPostImportRepository,
    VkParsingService,
    SupportRequestsService,
  ],
})
export class AdminModule {}
