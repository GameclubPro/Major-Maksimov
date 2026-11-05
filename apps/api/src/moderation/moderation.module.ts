import { ModerationRuleFollowupService } from './moderation-rule-followup.service';
import { RequiredSubscriptionCandidateService } from './required-subscription-candidate.service';
import { RequiredSubscriptionCandidateStore } from './required-subscription-candidate.store';
import { MODERATION_RULE_FOLLOWUP_EXECUTOR } from './moderation-rule-followup.contract';
import { GlobalSpammerPolicyModule } from './global-spammer-policy.module';
import { NativePhotoSandboxClient } from './photo-duplicate/native-photo-sandbox.client';
import { registerRuntimeQueues } from '../runtime/runtime-queues';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminModule } from '../admin/admin.module';
import { ReportsModule } from './reports/reports.module';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { MaxModule } from '../max/max.module';
import { getAppRole, roleRunsModeration, roleRunsPublisher } from '../runtime/app-role';
import { PublisherChatCommentDeliveryService } from '../publisher/publisher-chat-comment-delivery.service';
import { PublisherCommentNotificationDeliveryService } from '../publisher/publisher-comment-notification-delivery.service';
import { PublisherChannelCommentDeliveryService } from '../publisher/publisher-channel-comment-delivery.service';
import { PublisherChatCommentProcessor } from '../publisher/publisher-chat-comment.processor';
import { PublisherChatCommentRecoveryService } from '../publisher/publisher-chat-comment-recovery.service';
import {
  PUBLISHER_CHAT_COMMENT_QUEUE,
  PublisherChatCommentQueueService,
} from '../publisher/publisher-chat-comment.queue';
import {
  commercialOcrProcessorEnabled,
  getEnabledModerationProcessorQueues,
  getWebhookDynamicLeasesWorkerGroup,
  spammerDenormProcessorEnabled,
} from '../runtime/moderation-runtime';
import {
  MODERATION_EXECUTION_LEGACY,
  ModerationExecutionService,
} from './moderation-execution.service';
import { NightModeTransitionModule } from './night-mode-transition.module';
import { NightModeTransitionDeliveryService } from './night-mode-transition-delivery.service';
import { NightModeRouteVerificationService } from './night-mode-route-verification.service';
import { NightModeTransitionRuntimeService } from './night-mode-transition-runtime.service';
import { NightModeTransitionProcessor } from './night-mode-transition.processor';
import { GlobalSpammerDenormProcessor } from './global-spammer-denorm.processor';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from './global-spammer-denorm.queue';
import { SystemModule } from '../system/system.module';
import { KaravanStorefrontRelayModule } from '../integrations/karavan-storefront/karavan-storefront-relay.module';
import { KaravanStorefrontAuthorizationService } from '../integrations/karavan-storefront/karavan-storefront-authorization.service';
import { KaravanStorefrontRelayService } from '../integrations/karavan-storefront/karavan-storefront-relay.service';
import {
  BackgroundWebhookProcessor,
  CriticalWebhookProcessor,
  DEFAULT_WEBHOOK_SHARD_PROCESSORS,
  JOIN_WEBHOOK_SHARD_PROCESSORS,
  LegacyModerationProcessor,
  ModerationService,
} from './moderation.service';
import { DefaultWebhookLeaseManagerService } from './default-webhook-lease-manager.service';
import { GlobalSpammerArchiveRunnerService } from './global-spammer-archive-runner.service';
import {
  ALL_WEBHOOK_QUEUE_NAMES,
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';
import { PrivateControlController } from './private-control.controller';
import { PrivateControlService } from './private-control.service';
import { ModerationAccessService } from './moderation-access.service';
import { RedisCounterModule } from './redis-counter.module';
import { RuleEngineModule } from './rule-engine.module';
import { SanctionService } from './sanction.service';
import { BotSpeechMediaService } from './bot-speech-media.service';
import { NightModeOpenNoticeCleanupService } from './night-mode-open-notice-cleanup.service';
import { NightModeTransitionEventService } from './night-mode-transition-event.service';
import { WebhookCanonicalExecutionService } from './webhook-canonical-execution.service';
import { ModerationDeleteIntentModule } from './moderation-delete-intent.module';
import { PHOTO_DUPLICATE_QUEUE } from './photo-duplicate/photo-duplicate.queue';
import {
  MESSAGE_DUPLICATE_QUEUE,
  MessageDuplicateEnqueueService,
} from './message-duplicate/message-duplicate.queue';
import { MessageDuplicateStateModule } from './message-duplicate/message-duplicate-state.module';
import { MessageDuplicateService } from './message-duplicate/message-duplicate.service';
import { MessageDuplicateEnforcementService } from './message-duplicate/message-duplicate-enforcement.service';
import { MessageDuplicateMediaService } from './message-duplicate/message-duplicate-media.service';
import { MessageDuplicateProcessor } from './message-duplicate/message-duplicate.processor';
import { PhotoDuplicateProcessor } from './photo-duplicate/photo-duplicate.processor';
import { PhotoDuplicateOrderingStore } from './photo-duplicate/photo-duplicate-ordering.store';
import { PhotoDuplicateAnalysisService } from './photo-duplicate/photo-duplicate-analysis.service';
import { PhotoDuplicateHistoryStore } from './photo-duplicate/photo-duplicate-history.store';
import { PhotoFingerprintService } from './photo-duplicate/photo-fingerprint';
import { SecurePhotoDownloader } from './photo-duplicate/secure-photo-downloader';
import { LinkHistoryRecoveryService } from './link-history-recovery.service';
import { CommercialOcrAdmissionStore } from './commercial-ocr/commercial-ocr-admission.store';
import { CommercialOcrAnalysisService } from './commercial-ocr/commercial-ocr-analysis.service';
import { CommercialOcrCacheStore } from './commercial-ocr/commercial-ocr-cache.store';
import { CommercialOcrEnqueueService } from './commercial-ocr/commercial-ocr-enqueue.service';
import { CommercialOcrModerationService } from './commercial-ocr/commercial-ocr-moderation.service';
import { CommercialOcrMetricsService } from './commercial-ocr/commercial-ocr-metrics.service';
import { CommercialOcrPreprocessor } from './commercial-ocr/commercial-ocr-preprocessor';
import { CommercialOcrProcessor } from './commercial-ocr/commercial-ocr.processor';
import { CommercialOcrQueueProducer } from './commercial-ocr/commercial-ocr-queue.producer';
import { COMMERCIAL_OCR_QUEUE } from './commercial-ocr/commercial-ocr.queue';
import { NativeTesseractOcrAdapter } from './commercial-ocr/native-tesseract-ocr.adapter';
import { PublisherAutoReplyDeliveryService } from '../publisher/publisher-auto-reply-delivery.service';
import { PublisherAutoReplyProcessor } from '../publisher/publisher-auto-reply.processor';
import { PublisherAutoReplyRecoveryService } from '../publisher/publisher-auto-reply-recovery.service';
import {
  PUBLISHER_AUTO_REPLY_QUEUE,
  PublisherAutoReplyQueueService,
} from '../publisher/publisher-auto-reply.queue';

const enabledModerationQueues = getEnabledModerationProcessorQueues();
const dynamicDefaultWorkerGroup = getWebhookDynamicLeasesWorkerGroup();
const moderationRoleEnabled = roleRunsModeration(getAppRole());
const photoDuplicateProcessorEnabled =
  moderationRoleEnabled && enabledModerationQueues.has(WEBHOOK_QUEUE_BACKGROUND);
const commercialOcrWorkerEnabled = commercialOcrProcessorEnabled();
const commercialOcrEnqueueEnabled = moderationRoleEnabled && enabledModerationQueues.size > 0;
const moderationProviders = [
  ModerationService,
  ModerationRuleFollowupService,
  RequiredSubscriptionCandidateStore,
  RequiredSubscriptionCandidateService,
  { provide: MODERATION_RULE_FOLLOWUP_EXECUTOR, useExisting: ModerationService },
  {
    provide: MODERATION_EXECUTION_LEGACY,
    useExisting: ModerationService,
  },
  ModerationExecutionService,
  ModerationAccessService,
  KaravanStorefrontAuthorizationService,
  KaravanStorefrontRelayService,
  BotSpeechMediaService,
  NightModeTransitionEventService,
  NightModeOpenNoticeCleanupService,
  NightModeTransitionDeliveryService,
  NightModeRouteVerificationService,
  NightModeTransitionRuntimeService,
  PrivateControlService,
  GlobalSpammerArchiveRunnerService,
  SanctionService,
  WebhookCanonicalExecutionService,
  LinkHistoryRecoveryService,
  PublisherChatCommentQueueService,
  PublisherAutoReplyQueueService,
  MessageDuplicateEnqueueService,
  MessageDuplicateEnforcementService,
  MessageDuplicateService,
  ...(commercialOcrEnqueueEnabled || commercialOcrWorkerEnabled
    ? [CommercialOcrAdmissionStore, CommercialOcrMetricsService]
    : []),
  ...(commercialOcrEnqueueEnabled
    ? [
        {
          provide: CommercialOcrQueueProducer,
          inject: [ConfigService],
          useFactory: (configService: ConfigService) =>
            new CommercialOcrQueueProducer(configService.getOrThrow<string>('REDIS_URL')),
        },
        CommercialOcrEnqueueService,
      ]
    : []),
  ...(photoDuplicateProcessorEnabled || commercialOcrWorkerEnabled ? [SecurePhotoDownloader] : []),
  ...(dynamicDefaultWorkerGroup ? [DefaultWebhookLeaseManagerService] : []),
  ...(moderationRoleEnabled
    ? [
        ...(enabledModerationQueues.has(LEGACY_WEBHOOK_QUEUE) ? [LegacyModerationProcessor] : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_CRITICAL) ? [CriticalWebhookProcessor] : []),
        ...JOIN_WEBHOOK_QUEUE_NAMES.flatMap((queueName, index) =>
          enabledModerationQueues.has(queueName) ? [JOIN_WEBHOOK_SHARD_PROCESSORS[index]!] : [],
        ),
        ...(dynamicDefaultWorkerGroup
          ? []
          : DEFAULT_WEBHOOK_QUEUE_NAMES.flatMap((queueName, index) =>
              enabledModerationQueues.has(queueName)
                ? [DEFAULT_WEBHOOK_SHARD_PROCESSORS[index]!]
                : [],
            )),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_BACKGROUND)
          ? [BackgroundWebhookProcessor]
          : []),
        ...(enabledModerationQueues.has(WEBHOOK_QUEUE_BACKGROUND) &&
        roleRunsModeration(getAppRole())
          ? [NightModeTransitionProcessor]
          : []),
        ...(spammerDenormProcessorEnabled() ? [GlobalSpammerDenormProcessor] : []),
        ...(photoDuplicateProcessorEnabled
          ? [
              PhotoDuplicateOrderingStore,
              PhotoDuplicateProcessor,
              PhotoDuplicateHistoryStore,
              {
                provide: PhotoFingerprintService,
                inject: [ConfigService],
                useFactory: (configService: ConfigService) =>
                  new PhotoFingerprintService({
                    canonicalOnly: true,
                    nativeDecoder: (() => {
                      const socketPath = configService.get<string>(
                        'PHOTO_NATIVE_SANDBOX_SOCKET_PATH',
                      );
                      if (!socketPath && process.env.NODE_ENV === 'production')
                        throw new Error(
                          'Production photo decoding requires the native photo sandbox',
                        );
                      return socketPath ? new NativePhotoSandboxClient(socketPath) : undefined;
                    })(),
                    maxInputBytes:
                      configService.get<number>('PHOTO_DUPLICATE_MAX_BYTES') ?? 16_777_216,
                    maxInputPixels:
                      configService.get<number>('PHOTO_DUPLICATE_MAX_PIXELS') ?? 40_000_000,
                  }),
              },
              PhotoDuplicateAnalysisService,
              MessageDuplicateMediaService,
              MessageDuplicateProcessor,
            ]
          : []),
        ...(commercialOcrWorkerEnabled
          ? [
              CommercialOcrCacheStore,
              CommercialOcrPreprocessor,
              NativeTesseractOcrAdapter,
              CommercialOcrAnalysisService,
              CommercialOcrModerationService,
              CommercialOcrProcessor,
            ]
          : []),
      ]
    : []),
  ...(roleRunsPublisher(getAppRole())
    ? [
        PublisherChatCommentDeliveryService,
        PublisherCommentNotificationDeliveryService,
        PublisherChannelCommentDeliveryService,
        PublisherChatCommentProcessor,
        PublisherChatCommentRecoveryService,
        PublisherAutoReplyDeliveryService,
        PublisherAutoReplyProcessor,
        PublisherAutoReplyRecoveryService,
      ]
    : []),
];

@Module({
  imports: [
    ...registerRuntimeQueues(...ALL_WEBHOOK_QUEUE_NAMES),
    ...registerRuntimeQueues(GLOBAL_SPAMMER_DENORM_QUEUE),
    ...registerRuntimeQueues(PHOTO_DUPLICATE_QUEUE),
    ...registerRuntimeQueues(MESSAGE_DUPLICATE_QUEUE),
    ...registerRuntimeQueues(PUBLISHER_CHAT_COMMENT_QUEUE),
    ...registerRuntimeQueues(PUBLISHER_AUTO_REPLY_QUEUE),
    ...(commercialOcrWorkerEnabled ? registerRuntimeQueues(COMMERCIAL_OCR_QUEUE) : []),
    MaxModule,
    SystemModule,
    ChatContextModule,
    AdminModule,
    NightModeTransitionModule,
    RedisCounterModule,
    RuleEngineModule,
    KaravanStorefrontRelayModule,
    ModerationDeleteIntentModule,
    GlobalSpammerPolicyModule,
    MessageDuplicateStateModule,
    ReportsModule,
  ],
  controllers: [PrivateControlController],
  providers: moderationProviders,
  exports: [
    ModerationExecutionService,
    ModerationService,
    ModerationDeleteIntentModule,
    GlobalSpammerPolicyModule,
    ...(commercialOcrEnqueueEnabled || commercialOcrWorkerEnabled
      ? [CommercialOcrMetricsService]
      : []),
    ...(commercialOcrWorkerEnabled ? [NativeTesseractOcrAdapter] : []),
  ],
})
export class ModerationModule {}
