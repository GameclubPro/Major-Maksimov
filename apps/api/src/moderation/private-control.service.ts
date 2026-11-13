import { SuggestionNativeQueueService } from '../publisher/suggestion-native.queue';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BroadcastHandoffResponse,
  BroadcastHandoffState,
  ManagedEntityType,
  MaxUpdate,
} from '@maxim/contracts';
import type { KaravanStorefrontHandoffResponse } from '@maxim/contracts/karavan-storefront';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { isManagedEntityForwardedRecoveryMessage } from '../common/managed-entity-forwarded-recovery.util';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { shouldPreferActiveContentInputForForward } from './private-control-forward-routing';
import { AdminDialogLinkService } from '../admin/admin-dialog-link.service';
import { AdminService } from '../admin/admin.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { ManagedBroadcastService } from '../admin/managed-broadcast.service';
import { ManagedGiveawayService } from '../admin/managed-giveaway.service';
import { ManualModerationService } from '../admin/manual-moderation.service';
import { SupportRequestsService } from '../admin/support-requests.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxClientService } from '../max/max-client.service';
import { ManagedEntityHandshakeService } from '../max/managed-entity-handshake.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { KaravanStorefrontAllowlistService } from '../integrations/karavan-storefront/karavan-storefront-allowlist.service';
import { RedisCounterService } from './redis-counter.service';
import type { PrivateSession } from './private-control.types';
import { PrivateControlService as LegacyPrivateControlService } from './private-control.service.legacy';

const FORWARDED_RECOVERY_SESSION_LOOKUP_TIMEOUT_MS = 250;

@Injectable()
export class PrivateControlService extends LegacyPrivateControlService {
  constructor(
    maxClient: MaxClientService,
    adminService: AdminService,
    adminSettingsService: AdminSettingsService,
    manualModerationService: ManualModerationService,
    managedGiveawayService: ManagedGiveawayService,
    @Optional() redisCounter?: RedisCounterService,
    @Optional() configService?: ConfigService,
    @Optional() maxBotLinkService?: MaxBotLinkService,
    @Optional() managedBroadcastService?: ManagedBroadcastService,
    @Optional() adminDialogLinkService?: AdminDialogLinkService,
    @Optional() supportRequestsService?: SupportRequestsService,
    @Optional() prisma?: PrismaService,
    @Optional()
    private readonly managedEntityHandshakeService?: ManagedEntityHandshakeService,
    @Optional() karavanStorefrontAllowlistService?: KaravanStorefrontAllowlistService,
    @Optional() legacyHolds?: WebhookLegacyHoldService,
    @Optional() private readonly nativeReview?: SuggestionNativeQueueService,
  ) {
    super(
      maxClient,
      adminService,
      adminSettingsService,
      manualModerationService,
      managedGiveawayService,
      redisCounter,
      configService,
      maxBotLinkService,
      managedBroadcastService,
      adminDialogLinkService,
      supportRequestsService,
      prisma,
      karavanStorefrontAllowlistService,
      legacyHolds,
    );
  }

  override handleUpdate(update: MaxUpdate): Promise<void> {
    return this.runWithUpdateSessionBot(update, async () => {
      if (await this.nativeReview?.observeWebhook(update)) return;
      const forwardedRecovery = isManagedEntityForwardedRecoveryMessage(update);
      const userId = update.message?.senderId?.trim();
      let preferContentInput = false;
      if (forwardedRecovery && userId) {
        try {
          const session = await raceWithTimeout<PrivateSession | null>({
            operation: this.loadSession(userId),
            timeoutMs: FORWARDED_RECOVERY_SESSION_LOOKUP_TIMEOUT_MS,
            onTimeout: () => null,
          });
          preferContentInput = session ? shouldPreferActiveContentInputForForward(session) : false;
        } catch {
          // Managed-entity recovery must not depend on optional private-session storage.
          preferContentInput = false;
        }
      }
      if (forwardedRecovery && !preferContentInput) {
        return this.managedEntityHandshakeService
          ? this.managedEntityHandshakeService.handleWebhookUpdate(update).then(() => undefined)
          : undefined;
      }

      return super.handleUpdate(update);
    });
  }

  override handleBotStarted(update: MaxUpdate): Promise<void> {
    return this.runWithUpdateSessionBot(update, () => super.handleBotStarted(update));
  }

  override handoffKaravanStorefrontAllowlistFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<KaravanStorefrontHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffKaravanStorefrontAllowlistFromMiniapp(sourceChatId, user),
    );
  }

  override handoffBroadcastFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffBroadcastFromMiniapp(sourceChatId, user, body, entityType),
    );
  }

  override getBroadcastHandoffState(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffState> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.getBroadcastHandoffState(sourceChatId, user, entityType),
    );
  }

  override clearBroadcastHandoffState(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffState> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.clearBroadcastHandoffState(sourceChatId, user, entityType),
    );
  }

  override handoffRulesFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<BroadcastHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffRulesFromMiniapp(sourceChatId, user),
    );
  }

  override openChannelSuggestionFromCallback(params: {
    userId: string;
    chatId: string;
    token: string;
    botId?: string | null;
  }): Promise<boolean> {
    return this.runWithSessionBot(params.botId, () =>
      super.openChannelSuggestionFromCallback(params),
    );
  }

  override handoffGiveawayFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffGiveawayFromMiniapp(sourceChatId, user, body, entityType),
    );
  }

  override handoffProfileMentionFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    targetUserId: string,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    return this.runWithSessionBot(user.launchBotId, () =>
      super.handoffProfileMentionFromMiniapp(sourceChatId, user, targetUserId, body, entityType),
    );
  }
}
