import { KaravanMarketplaceAuthorityService } from '../integrations/karavan-marketplace/karavan-marketplace-authority.service';
import { KaravanMarketplacePublicationPolicyService } from '../integrations/karavan-marketplace/karavan-marketplace-publication-policy.service';
import { KaravanMarketplaceResolverService } from '../integrations/karavan-marketplace/karavan-marketplace-resolver.service';
import { registerRuntimeQueues } from '../runtime/runtime-queues';
import { MarketplaceStateModule } from '../integrations/marketplace/marketplace-state.module';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ChatContextModule } from '../chat-context/chat-context.module';
import { NightModeTransitionModule } from '../moderation/night-mode-transition.module';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { SystemRuntimeModule } from '../system/system-runtime.module';
import { ManagedEntityAccessLossService } from './managed-entity-access-loss.service';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import { MaxActionLedgerService } from './max-action-ledger.service';
import {
  MaxActionBackgroundProcessor,
  MaxActionCriticalProcessor,
  MaxActionInteractiveProcessor,
  MaxActionProcessor,
} from './max-action.processor';
import { MAX_ACTION_ALL_QUEUE_NAMES } from './max-action.queue';
import { MaxChatAdminRosterSyncProcessor } from './max-chat-admin-roster-sync.processor';
import { MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE } from './max-chat-admin-roster-sync.queue';
import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';
import { MaxBotExecutionPlannerService } from './max-bot-execution-planner.service';
import { MaxClientService } from './max-client.service';
import { AutomaticDeleteAuthorAccessService } from './automatic-delete-author-access.service';
import { MaxMembershipLookupService } from './max-membership-lookup.service';
import { MaxRoutedPublicationService } from './max-routed-publication.service';
import { MaxWebhookSubscriptionReconcilerService } from './max-webhook-subscription-reconciler.service';
import { ManagedEntityAccessWriter } from './managed-entity-access-writer.service';
import { ManagedEntityHandshakeService } from './managed-entity-handshake.service';
import { ManagedEntityHandshakeOutcomeService } from './managed-entity-handshake-outcome.service';
import { MaxBotModule } from './max-bot.module';
import { GroupCommandAuthorityService } from '../common/group-command-authority.service';
import { RedisCounterModule } from '../moderation/redis-counter.module';
import { MaxExecutionOwnerReadinessService } from './max-execution-owner-readiness.service';
import { MaxModerationRuleNoticeGuardService } from './max-moderation-rule-notice.guard';
import { MaxRequiredSubscriptionNoticeGuardService } from './max-required-subscription-notice.guard';
import { MaxDuplicateNoticeGuardService } from './max-duplicate-notice.guard';
import { ParticipantModerationImmunityService } from '../moderation/participant-moderation-immunity.service';

const maxProviders = [
  KaravanMarketplaceAuthorityService,
  KaravanMarketplacePublicationPolicyService,
  KaravanMarketplaceResolverService,
  GroupCommandAuthorityService,
  MaxClientService,
  AutomaticDeleteAuthorAccessService,
  MaxModerationRuleNoticeGuardService,
  MaxRequiredSubscriptionNoticeGuardService,
  MaxDuplicateNoticeGuardService,
  ParticipantModerationImmunityService,
  MaxActionDispatchService,
  MaxActionLedgerService,
  MaxChatAdminRosterSyncService,
  MaxBotExecutionPlannerService,
  MaxExecutionOwnerReadinessService,
  MaxMembershipLookupService,
  MaxRoutedPublicationService,
  MaxWebhookSubscriptionReconcilerService,
  ManagedEntityAccessLossService,
  ManagedEntityAccessWriter,
  ManagedEntityHandshakeOutcomeService,
  ManagedEntityHandshakeService,
  ...(roleRunsAction(getAppRole())
    ? [
        MaxActionProcessor,
        MaxActionCriticalProcessor,
        MaxActionInteractiveProcessor,
        MaxActionBackgroundProcessor,
      ]
    : []),
  ...(roleRunsAction(getAppRole()) ? [MaxChatAdminRosterSyncProcessor] : []),
];

@Module({
  imports: [
    HttpModule.register({
      timeout: 5_000,
      maxRedirects: 0,
    }),
    SystemRuntimeModule,
    MaxBotModule,
    RedisCounterModule,
    MarketplaceStateModule,
    ChatContextModule,
    NightModeTransitionModule,
    ...registerRuntimeQueues(...MAX_ACTION_ALL_QUEUE_NAMES),
    ...registerRuntimeQueues(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE),
  ],
  providers: maxProviders,
  exports: [
    KaravanMarketplaceAuthorityService,
    KaravanMarketplaceResolverService,
    GroupCommandAuthorityService,
    MaxClientService,
    AutomaticDeleteAuthorAccessService,
    MaxActionDispatchService,
    MaxActionLedgerService,
    MaxChatAdminRosterSyncService,
    MaxBotExecutionPlannerService,
    MaxExecutionOwnerReadinessService,
    MaxMembershipLookupService,
    MaxRoutedPublicationService,
    MaxWebhookSubscriptionReconcilerService,
    ManagedEntityAccessLossService,
    ManagedEntityAccessWriter,
    ManagedEntityHandshakeOutcomeService,
    ManagedEntityHandshakeService,
  ],
})
export class MaxModule {}
