import { SuggestionNativeQueueService } from './suggestion-native.queue';
import { ADMIN_SUGGESTION_DELIVERY_QUEUE } from '../admin/admin-suggestion-delivery.queue';
import { PublisherAccessRefreshPolicy } from './publisher-access-refresh-policy';
import { PublisherAccessRefreshEvidenceService } from './publisher-access-refresh-evidence.service';
import { registerRuntimeQueues } from '../runtime/runtime-queues';
import { SuggestionSubscriptionModule } from '../suggestions/suggestion-subscription.module';
import { Global, Module } from '@nestjs/common';
import { MaxModule } from '../max/max.module';
import { SystemModule } from '../system/system.module';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import { PublisherBindingRefreshProcessor } from './publisher-binding-refresh.processor';
import {
  PUBLISHER_CHAT_COMMENT_QUEUE,
  PublisherChatCommentQueueService,
} from './publisher-chat-comment.queue';
import {
  PUBLISHER_BINDING_REFRESH_QUEUE,
  PublisherBindingRefreshQueueService,
} from './publisher-binding-refresh.queue';
import {
  PublisherBindingRefreshSchedulerService,
  PublisherBindingRefreshService,
} from './publisher-binding-refresh.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherEntityBindingLifecycleService } from './publisher-entity-binding-lifecycle.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PublisherRuntimeHeartbeatReaderService,
  PublisherRuntimeHeartbeatWriterService,
} from './publisher-runtime-heartbeat.service';
import { PublisherWebhookSubscriptionReconcilerService } from './publisher-webhook-subscription-reconciler.service';
import { PublisherDialogLinkService } from './publisher-dialog-link.service';
import { PublisherChatCommentProducerService } from './publisher-chat-comment-producer.service';
import { PublisherDialogSigningKeyService } from './publisher-dialog-signing-key.service';
import {
  PUBLISHER_POST_IMPORT_QUEUE,
  PublisherPostImportQueueService,
} from './publisher-post-import.queue';
import { PublisherPostImportService } from './publisher-post-import.service';
import { PublisherPostImportRecoveryService } from './publisher-post-import-recovery.service';
import {
  PUBLISHER_AUTO_REPLY_QUEUE,
  PublisherAutoReplyQueueService,
} from './publisher-auto-reply.queue';
import { PublisherAutoReplyProducerService } from './publisher-auto-reply-producer.service';
import { PublisherAutoReplyFloodGateService } from './publisher-auto-reply-flood-gate.service';
import { PublisherAutoReplySourceFenceService } from './publisher-auto-reply-source-fence.service';
import {
  PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE,
  PublisherAutoReplyAuthoringQueueService,
} from './publisher-auto-reply-authoring.queue';
import { PublisherAutoReplyAuthoringService } from './publisher-auto-reply-authoring.service';
import { PublisherAutoReplyAuthoringRecoveryService } from './publisher-auto-reply-authoring-recovery.service';
import { PublisherAutoReplyContentCaptureService } from './publisher-auto-reply-content-capture.service';
import { PublisherPrivateDialogFlowRouterService } from './publisher-private-dialog-flow-router.service';
import { PublisherPrivateFlowLeaseService } from './publisher-private-flow-lease.service';
import {
  PUBLISHER_SUGGESTION_ADMIN_QUEUE,
  PublisherSuggestionAdminQueueService,
} from './publisher-suggestion-admin.queue';
import { PublisherSuggestionAdminCallbackObserverService } from './publisher-suggestion-admin-callback-observer.service';
import { PublisherVkBotReviewQueueService } from './publisher-vk-bot-review.queue';
import { PUBLISHER_START_QUEUE, PublisherStartQueueService } from './publisher-start.queue';
import { PublisherStartProcessor } from './publisher-start.processor';
import { PublisherStartRecoveryService } from './publisher-start-recovery.service';
import { PublisherPublicationPostActionsService } from './publisher-publication-post-actions.service';
import { PublisherReadinessService } from './publisher-readiness.service';
import { PublisherPublicationAccessPreflightService } from './publisher-publication-access-preflight.service';
import {
  PUBLISHER_VIDEO_UPLOAD_QUEUE,
  PublisherVideoUploadQueueService,
} from './publisher-video-upload.queue';
import { PublisherVideoUploadProcessor } from './publisher-video-upload.processor';
import { PublisherCommentNotificationService } from './publisher-comment-notification.service';

const publisherRuntimeProviders = roleRunsPublisher(getAppRole())
  ? [
      PublisherActionCredentialService,
      PublisherIdentityAttestationService,
      PublisherRuntimeBoundaryService,
      PublisherRuntimeHeartbeatWriterService,
      PublisherBindingRefreshService,
      PublisherAccessRefreshEvidenceService,
      PublisherBindingRefreshProcessor,
      PublisherBindingRefreshSchedulerService,
      PublisherWebhookSubscriptionReconcilerService,
      PublisherPostImportRecoveryService,
      PublisherAutoReplyAuthoringRecoveryService,
      PublisherAutoReplyContentCaptureService,
      PublisherStartProcessor,
      PublisherStartRecoveryService,
      PublisherPublicationPostActionsService,
      PublisherPublicationAccessPreflightService,
      PublisherVideoUploadProcessor,
    ]
  : [];

const sharedPublisherProviders = [
  SuggestionNativeQueueService,
  PublisherAccessRefreshPolicy,
  PublisherCommentNotificationService,
  PublisherBackgroundWorkCoordinatorService,
  PublisherRuntimeHeartbeatReaderService,
  PublisherReadinessService,
  PublisherBindingRefreshQueueService,
  PublisherChatCommentQueueService,
  PublisherDispatchHealthService,
  PublisherEntityBindingLifecycleService,
  PublisherDialogSigningKeyService,
  PublisherDialogLinkService,
  PublisherChatCommentProducerService,
  PublisherPostImportQueueService,
  PublisherPostImportService,
  PublisherAutoReplyQueueService,
  PublisherAutoReplyFloodGateService,
  PublisherAutoReplySourceFenceService,
  PublisherAutoReplyProducerService,
  PublisherAutoReplyAuthoringQueueService,
  PublisherAutoReplyAuthoringService,
  PublisherSuggestionAdminQueueService,
  PublisherSuggestionAdminCallbackObserverService,
  PublisherVkBotReviewQueueService,
  PublisherPrivateFlowLeaseService,
  PublisherPrivateDialogFlowRouterService,
  PublisherStartQueueService,
  PublisherVideoUploadQueueService,
];

@Global()
@Module({
  imports: [
    SuggestionSubscriptionModule,
    MaxModule,
    SystemModule,
    ...registerRuntimeQueues(
      ADMIN_SUGGESTION_DELIVERY_QUEUE,
      PUBLISHER_BINDING_REFRESH_QUEUE,
      PUBLISHER_CHAT_COMMENT_QUEUE,
      PUBLISHER_POST_IMPORT_QUEUE,
      PUBLISHER_AUTO_REPLY_QUEUE,
      PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE,
      PUBLISHER_SUGGESTION_ADMIN_QUEUE,
      PUBLISHER_START_QUEUE,
      PUBLISHER_VIDEO_UPLOAD_QUEUE,
    ),
  ],
  providers: [...sharedPublisherProviders, ...publisherRuntimeProviders],
  exports: [...sharedPublisherProviders, ...publisherRuntimeProviders],
})
export class PublisherModule {}
