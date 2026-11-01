import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import * as settingsRenderer from './private-control-settings-renderer';
import * as legacyHoldAdvisory from './private-control-legacy-hold-advisory';
import {
  buildPrivateCallbackButton,
  buildPrivateCallbackPayload,
} from './private-control-callback-buttons';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  broadcastHandoffStateSchema,
  managedGiveawayHandoffRequestSchema,
  MAX_CHAT_RULES_TEXT_LENGTH,
  profileMentionHandoffRequestSchema,
  stepDeleteBotMessagesDelayMinutes,
  type BroadcastHandoffState,
  type BroadcastHandoffResponse,
  type BroadcastScheduleMode,
  type ChannelSettings,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type ManagedEntityHeader,
  type ManagedGiveawayDetails,
  type ManagedGiveawayWinner,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
  MANAGED_GIVEAWAY_MAX_PRIZES,
  type ManagedEntityType,
  type MaxUpdate,
  type PublishChannelEngagementRequest,
  type SendBroadcastResult,
  type UpdateManagedGiveawayRequest,
  DEFAULT_BROADCAST_BUTTON_TEXT,
} from '@maxim/contracts';
import {
  karavanStorefrontDurationSchema,
  karavanStorefrontHandoffResponseSchema,
} from '@maxim/contracts/karavan-storefront';
import type { SupportRequestAttachment } from '@maxim/contracts/support-requests';
import { AdminDialogLinkService } from '../admin/admin-dialog-link.service';
import { AdminService } from '../admin/admin.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { ManualModerationService } from '../admin/manual-moderation.service';
import { ManagedBroadcastService } from '../admin/managed-broadcast.service';
import { ManagedGiveawayService } from '../admin/managed-giveaway.service';
import { SupportRequestsService } from '../admin/support-requests.service';
import {
  KaravanStorefrontAllowlistService,
  resolveKaravanStorefrontExpiresAt,
} from '../integrations/karavan-storefront/karavan-storefront-allowlist.service';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { buildChatUserDisplayNameUpsert } from '../common/chat-user-display-name-read-model.util';
import { resolveMaxUserDisplayName } from '../common/max-user-display-name.util';
import {
  containsSupportedMarkdownSyntax,
  renderSupportedMarkdownAsHtml,
} from '../common/max-markdown.util';
import { renderMaxTextMarkupAsHtml } from '../common/max-text-markup.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
} from '../max/max-deep-link.util';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import {
  MaxClientService,
  type MaxCustomMessagePayload,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { normalizeMaxInlineKeyboardButtons } from '../max/max-inline-keyboard-layout';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import {
  extractIncomingFormattedText,
  extractIncomingFormattedTextPayload,
  extractIncomingMessageNode,
  extractIncomingSuggestionTextPayload,
} from './private-control-markup-importer';
import {
  BROADCAST_HANDOFF_DEDUP_WINDOW_MS,
  BROADCAST_HANDOFF_START_PAYLOAD,
  BROADCAST_PUBLISH_DEDUP_WINDOW_MS,
  BUTTON_TEXT_MAX_SINGLE_COLUMN,
  BUTTON_TEXT_MAX_TWO_COLUMNS,
  CALLBACK_REFRESH_NOTIFICATION,
  CALLBACK_STALE_NOTIFICATION,
  CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
  CHAT_ONLY_CALLBACK_ACTIONS,
  CHANNEL_ONLY_CALLBACK_ACTIONS,
  DEFAULT_BROADCAST_DRAFT,
  DEFAULT_PRIVATE_CALLBACK_ACK_TIMEOUT_MS,
  DEFAULT_PRIVATE_CALLBACK_EDIT_TIMEOUT_MS,
  DEFAULT_PRIVATE_CALLBACK_INLINE_BUDGET_MS,
  DEFAULT_PRIVATE_DIALOG_SEND_TIMEOUT_MS,
  DEFERRED_PRIVATE_CALLBACK_NOTIFICATION,
  ENTITY_CALLBACK_ACTIONS,
  GIVEAWAY_HANDOFF_DEDUP_WINDOW_MS,
  KARAVAN_ALLOWLIST_CALLBACK_ACTION,
  KARAVAN_ALLOWLIST_CANCEL_CALLBACK_ACTION,
  KARAVAN_ALLOWLIST_FLOW_TTL_MS,
  LAUNCHER_INTRO_MARKER_TTL_SEC,
  LEGACY_CALLBACK_PREFIX,
  MAX_CALLBACK_PREFIX,
  MINIAPP_ACTIVITY_ONLY_CALLBACK_ACTIONS,
  MINIAPP_BROADCAST_SETTINGS_CALLBACK_ACTIONS,
  MINIAPP_CHANNEL_SETTINGS_CALLBACK_ACTIONS,
  MINIAPP_GIVEAWAY_ONLY_CALLBACK_ACTIONS,
  MINIAPP_ROUTE_START_PARAM_PREFIX,
  MINIAPP_RULES_ONLY_CALLBACK_ACTIONS,
  MINIAPP_SETTINGS_ONLY_CALLBACK_ACTIONS,
  PAGE_SIZE_DOMAINS,
  PAGE_SIZE_EVENTS,
  PAGE_SIZE_MANUAL_USERS,
  PRIVATE_DIALOG_TERMINAL_FAILURE_METRIC_STATUSES,
  PROFILE_MENTION_HANDOFF_DEDUP_WINDOW_MS,
  RULES_HANDOFF_DEDUP_WINDOW_MS,
  RULES_HANDOFF_START_PAYLOAD,
  SUPPORT_CHAT_URL,
} from './private-control.constants';
import { extractPrivateControlUserErrorDetails } from './private-control-bad-request.util';
import {
  assertPrivateSuggestionMediaBot,
  assertPrivateSuggestionMediaCaptureBot,
  describePrivateSuggestionReviewError,
  buildPrivateChannelSuggestionSubmissionPayload,
} from './private-control-channel-suggestion';
import {
  buildBroadcastComposerClientResetKey,
  normalizeBroadcastComposerClientResetValue,
  rememberBroadcastComposerClientReset,
} from './private-control-broadcast-reset.util';
import type {
  ActiveBotSpeechProfile,
  CallbackAction,
  ChannelSectionKey,
  ForwardedModerationActionCommand,
  ForwardedModerationTarget,
  ForwardedRulesSource,
  PendingInput,
  PendingKaravanAllowlistFlow,
  PendingMassAction,
  PrivateBroadcastDraft,
  PrivateContext,
  PrivateScreen,
  PrivateSectionKey,
  PrivateSession,
  PrivateSuggestionDraft,
  PrivateView,
  SettingFieldConfig,
  SettingFieldType,
} from './private-control.types';
import {
  createDefaultPrivateControlSession,
  normalizePrivateControlSession,
  parsePrivateControlBroadcastView,
  parsePrivateControlChannelSection,
  parsePrivateControlEntityType,
  parsePrivateControlHomeTab,
  parsePrivateControlLogsRange,
  parsePrivateControlScreen,
  parsePrivateControlSection,
  parsePrivateControlSectionView,
  toPrivateControlPositiveInt,
} from './private-control-session-normalizer';
import {
  buildPrivateDownloadedFileName,
  buildPrivateSuggestionImageDraftsFromImages,
  buildPrivateSuggestionMediaDraftFromImage,
  buildPrivateSuggestionMediaDraftFromVideo,
  collectPrivateMessageAttachments,
  downloadPrivateImageSourceAttachment,
  extractPrivateFirstFileAttachment,
  extractPrivateFirstImageSourceAttachment,
  extractPrivateFirstVideoSourceAttachment,
  extractPrivateImageSourceAttachments,
  hasPrivateVideoAttachment,
  type PrivateControlMediaAttachmentUploader,
} from './private-control-media-attachments';
import {
  dedupePrivateForwardedModerationTargets,
  dedupePrivateForwardedRulesSources,
  extractForwardedModerationTargets,
  extractPrivateForwardedModerationTargets,
  extractPrivateForwardedRulesSources,
  parsePrivateForwardedModerationCommand,
} from './admin-forwarded-command.util';
import {
  clonePrivateBroadcastDraft,
  normalizePrivateBroadcastDraft,
  normalizePrivateBroadcastTargetChatIds,
  normalizePrivateSuggestionDraft,
  resolvePrivateBroadcastDraftTargetState,
} from './private-control-draft-normalizer';
import { buildPrivateChatRulesDraft } from './private-control-rules-draft';
import { buildPrivateRulesScreenTextPreview } from './private-control-rules-preview';
import { buildPrivateRulesTextItems } from './private-control-rules-text-renderer';
import { publishPrivateRules } from './private-control-rules-publication';
import { resolvePrivateControlSetFieldInputText } from './private-control-forward-routing';
import { PrivateControlSessionStore } from './private-control-session.store';
import { PrivateControlSessionBotContext } from './private-control-session-bot-context';
import {
  compactPrivateText,
  escapePrivateMarkdown,
  privateMarkdownTitle,
  renderPrivateLauncherHomeView,
  renderPrivateLauncherIntroView,
  renderPrivateMiniappMovedView,
} from './private-control-launcher-renderer';
import {
  asPrivateControlRecord,
  formatPrivateControlAllowlistEntryLabel,
  formatPrivateControlDateTimeLabel,
  formatPrivateControlIsoDate,
  limitPrivateControlMessageText,
  paginatePrivateControlItems,
  readPrivateControlString,
} from './private-control-formatting.util';
import {
  parsePrivateControlBroadcastSendAt,
  parsePrivateControlDateInput,
  parsePrivateControlInputValue,
  parsePrivateControlIntegerInput,
  parsePrivateControlRemovalDateInput,
} from './private-control-input-values';
import {
  clearPendingPrivateProfileMentionHandoff,
  clearPrivateHandoffDelivery,
  readPendingPrivateProfileMentionDisplayName,
  rememberPendingPrivateProfileMentionHandoff,
  wasPrivateHandoffRecentlyDelivered,
} from './private-control-handoff-state';
import {
  formatKaravanAllowlistChatTitle,
  isPresentableKaravanAllowlistChatTitle,
  resolveKaravanAllowlistChatTitle,
} from './private-control-karavan-allowlist-title';
import {
  deliverPrivateScreenHandoffToKnownPrivateChat,
  preparePrivateHandoffBot,
  type PrivateScreenHandoffKind,
} from './private-control-handoff-delivery';
import {
  deliverPrivateProfileMentionHandoffToKnownPrivateChat,
  renderPrivateProfileMentionMessage,
} from './private-control-profile-mention-handoff';
import {
  buildPrivateGiveawayHandoffStartPayload,
  buildPrivateKaravanAllowlistStartPayload,
  buildPrivateProfileMentionStartPayload,
  parsePrivateGiveawayHandoffStartPayload,
  parsePrivateKaravanAllowlistStartPayload,
  parsePrivateProfileMentionStartPayload,
} from './private-control-handoff-start-payload';
import {
  isPrivateDuplicateFlowSettingKey,
  normalizePrivateDuplicateFlowSettings,
} from './private-control-duplicate-flow';
import {
  CHANNEL_SECTION_FIELDS,
  CHANNEL_SECTION_LABELS,
  SECTION_CARD_FIELDS,
  SECTION_FIELDS,
  SECTION_LABELS,
  SECTION_ORDER,
  SECTION_SETTING_KEYS,
} from './private-control-settings-schema';
import * as publicationWriteFreeze from './private-control-publication-write-freeze';
import { DEFAULT_MAX_PUBLISHER_BOT_ID } from '../publisher/publisher-bot-descriptor';
import { RedisCounterService } from './redis-counter.service';

@Injectable()
export class PrivateControlService {
  private readonly logger = new Logger(PrivateControlService.name);
  private readonly appBaseUrl: string | null;
  private readonly botDeepLinkId: string | null;
  private readonly publisherBotId: string;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly ownBotUserIdVariants: Set<string>;
  private readonly maxBotToken: string;
  private readonly maxBotTokenValidationSecrets: readonly string[];
  private readonly privateCallbackInlineBudgetMs: number;
  private readonly privateCallbackAckTimeoutMs: number;
  private readonly privateCallbackEditTimeoutMs: number;
  private readonly privateDialogSendTimeoutMs: number;
  private readonly privateControlMediaUploader: PrivateControlMediaAttachmentUploader;
  private readonly sessionStore: PrivateControlSessionStore;
  private readonly describeChatHolds: ReturnType<typeof legacyHoldAdvisory.create>;
  private readonly sessionBotContext = new PrivateControlSessionBotContext();
  private readonly launcherIntroSeenUsers = new Set<string>();
  private readonly activeBroadcastPublishes = new Set<string>();
  private readonly recentBroadcastPublishes = new Map<
    string,
    { fingerprint: string; expiresAt: number }
  >();

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly adminService: AdminService,
    private readonly adminSettingsService: AdminSettingsService,
    private readonly manualModerationService: ManualModerationService,
    private readonly managedGiveawayService: ManagedGiveawayService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional() configService?: ConfigService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly managedBroadcastService?: ManagedBroadcastService,
    @Optional() private readonly adminDialogLinkService?: AdminDialogLinkService,
    @Optional() private readonly supportRequestsService?: SupportRequestsService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional()
    private readonly karavanStorefrontAllowlistService?: KaravanStorefrontAllowlistService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {
    this.describeChatHolds = legacyHoldAdvisory.create(this.adminService, this.legacyHolds);
    this.appBaseUrl = this.normalizeAppBaseUrl(configService?.get<string>('APP_BASE_URL'));
    this.botDeepLinkId = this.normalizeBotDeepLinkId(configService?.get<string>('MAX_BOT_ID'));
    this.publisherBotId =
      this.normalizeBotDeepLinkId(configService?.get<string>('MAX_PUBLISHER_BOT_ID')) ||
      DEFAULT_MAX_PUBLISHER_BOT_ID;
    this.explicitBotContactId = this.normalizeBotContactId(
      configService?.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = this.normalizeOwnBotUserId(configService?.get<string>('MAX_BOT_ID'));
    this.ownBotUserIdVariants = this.buildBotIdVariants(this.ownBotUserId);
    const configuredBotTokens = collectBotTokenSecrets(
      configService?.get<string>('MAX_BOT_TOKEN'),
      configService?.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    this.maxBotToken =
      this.maxBotLinkService?.getBotTokenSync() ??
      configuredBotTokens[0] ??
      this.botDeepLinkId ??
      'max-bot';
    this.maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [this.maxBotToken]);
    this.privateCallbackInlineBudgetMs = toPrivateControlPositiveInt(
      configService?.get('PRIVATE_CALLBACK_INLINE_BUDGET_MS'),
      DEFAULT_PRIVATE_CALLBACK_INLINE_BUDGET_MS,
    );
    this.privateCallbackAckTimeoutMs = toPrivateControlPositiveInt(
      configService?.get('PRIVATE_CALLBACK_ACK_TIMEOUT_MS'),
      DEFAULT_PRIVATE_CALLBACK_ACK_TIMEOUT_MS,
    );
    this.privateCallbackEditTimeoutMs = toPrivateControlPositiveInt(
      configService?.get('PRIVATE_CALLBACK_EDIT_TIMEOUT_MS'),
      DEFAULT_PRIVATE_CALLBACK_EDIT_TIMEOUT_MS,
    );
    this.privateDialogSendTimeoutMs = toPrivateControlPositiveInt(
      configService?.get('PRIVATE_DIALOG_SEND_TIMEOUT_MS'),
      DEFAULT_PRIVATE_DIALOG_SEND_TIMEOUT_MS,
    );
    this.privateControlMediaUploader = {
      uploadImage: (data, fileName, mimeType) =>
        this.maxClient.uploadImage(data, fileName, mimeType),
      uploadVideo: (data, fileName, mimeType) =>
        this.maxClient.uploadVideo(data, fileName, mimeType),
    };
    this.sessionStore = new PrivateControlSessionStore({
      redisCounter,
      logger: this.logger,
      normalizeSession: (raw) => this.normalizeSession(raw),
      createDefaultSession: () => this.createDefaultSession(),
    });
  }

  async handleUpdate(update: MaxUpdate): Promise<void> {
    const context = this.resolveContext(update);
    if (!context) {
      return;
    }

    const callback = context.callbackPayload
      ? this.parseCallbackAction(context.callbackPayload)
      : null;

    try {
      if (context.callbackPayload) {
        await this.processCallbackWithinInlineBudget(context, callback);
        return;
      }

      await this.processTextMessage(context);
    } catch (error: unknown) {
      await this.handlePrivateControlError(context, callback, error);
    }
  }

  private async processCallbackWithinInlineBudget(
    context: PrivateContext,
    callback: CallbackAction | null,
  ): Promise<void> {
    const processingPromise = this.processCallback(context);
    processingPromise.catch(() => undefined);

    try {
      await this.awaitWithTimeout(
        processingPromise,
        this.privateCallbackInlineBudgetMs,
        `Private callback inline budget exceeded after ${this.privateCallbackInlineBudgetMs}ms`,
      );
    } catch (error: unknown) {
      if (!this.isTimeoutError(error)) {
        throw error;
      }

      if (context.callbackId) {
        await this.answerCallbackQuiet(
          context.callbackId,
          DEFERRED_PRIVATE_CALLBACK_NOTIFICATION,
          this.privateCallbackAckTimeoutMs,
          this.resolvePrivateDeliveryBotId(context),
          context.chatId,
        );
      }

      this.logger.warn(
        {
          chatId: context.chatId,
          userId: context.actor.userId,
          callbackAction: callback?.action ?? null,
          callbackArgs: callback?.args ?? [],
          callbackPayload: context.callbackPayload,
          timeoutMs: this.privateCallbackInlineBudgetMs,
        },
        'Private callback processing exceeded inline budget; continuing in background',
      );

      void processingPromise.catch((backgroundError: unknown) => {
        void this.handlePrivateControlError(context, callback, backgroundError).catch(
          (notificationError: unknown) => {
            this.logger.warn(
              {
                chatId: context.chatId,
                userId: context.actor.userId,
                err:
                  notificationError instanceof Error
                    ? notificationError.message
                    : String(notificationError),
              },
              'Failed to report detached private callback error',
            );
          },
        );
      });
    }
  }

  async handleBotStarted(update: MaxUpdate): Promise<void> {
    const context = this.resolveContext(update);
    if (!context) {
      return;
    }

    const startPayload = this.extractBotStartedStartPayload(update);
    const karavanAllowlistStart = this.parseKaravanAllowlistStartPayload(startPayload);
    if (karavanAllowlistStart) {
      await this.handleKaravanAllowlistStarted(context, karavanAllowlistStart);
      return;
    }
    const claimPayload = this.managedGiveawayService.parseClaimStartPayload(startPayload);
    if (claimPayload) {
      const claimContext = await this.managedGiveawayService.getGiveawayClaimContext(
        claimPayload.giveawayId,
        claimPayload.winnerId,
        context.actor.userId,
      );
      const view = claimContext
        ? this.renderGiveawayClaimView(claimContext)
        : this.renderUnavailableGiveawayClaimView();
      const session = await this.loadSession(context.actor.userId);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    const profileMentionPayload = this.parseProfileMentionStartPayload(startPayload);
    if (profileMentionPayload) {
      const session = await this.loadSession(context.actor.userId);
      this.rememberPrivateChatRoute(session, context);
      const pendingDisplayName = readPendingPrivateProfileMentionDisplayName(
        session,
        profileMentionPayload.chatId,
        profileMentionPayload.userId,
      );

      if (
        wasPrivateHandoffRecentlyDelivered(
          session,
          'profileMention',
          context.chatId,
          PROFILE_MENTION_HANDOFF_DEDUP_WINDOW_MS,
        )
      ) {
        clearPrivateHandoffDelivery(session, 'profileMention');
        clearPendingPrivateProfileMentionHandoff(session);
        await this.saveSession(context.actor.userId, session);
        return;
      }

      clearPendingPrivateProfileMentionHandoff(session);
      await this.saveSession(context.actor.userId, session);
      const deliveryBotId = this.resolvePrivateDeliveryBotId(context, session);
      const resolvedDisplayName = await this.resolveProfileMentionDisplayName(
        profileMentionPayload.chatId,
        profileMentionPayload.userId,
        pendingDisplayName ?? profileMentionPayload.displayName,
        deliveryBotId,
      );
      await this.sendProfileMentionToPrivateChat(
        context.chatId,
        resolvedDisplayName,
        profileMentionPayload.userId,
        deliveryBotId,
      );
      return;
    }

    const session = await this.loadSession(context.actor.userId);
    this.rememberPrivateChatRoute(session, context);
    if (
      startPayload === BROADCAST_HANDOFF_START_PAYLOAD ||
      this.hasRetiredPublishingSession(session)
    ) {
      await this.respond(context, session, this.renderPublikHandoff(session), {
        callbackId: null,
        notification: null,
      });
      return;
    }
    if (
      !startPayload &&
      wasPrivateHandoffRecentlyDelivered(
        session,
        'profileMention',
        context.chatId,
        PROFILE_MENTION_HANDOFF_DEDUP_WINDOW_MS,
      )
    ) {
      clearPrivateHandoffDelivery(session, 'profileMention');
      await this.saveSession(context.actor.userId, session);
      return;
    }
    const channelSuggestionPayload =
      this.adminDialogLinkService?.parseChannelSuggestionStartPayload(startPayload) ?? null;
    if (channelSuggestionPayload) {
      session.pendingInput = {
        kind: 'channel_suggestion',
        chatId: channelSuggestionPayload.chatId,
        token: channelSuggestionPayload.token,
      };
      session.suggestionDraft = null;
      session.pendingMassAction = null;
      session.managedGiveawayId = null;
      session.section = null;
      session.channelSection = null;
      session.searchQuery = null;
      session.lastScreenStack = [];
      const view = await this.renderChannelSuggestionIntroView(
        channelSuggestionPayload.chatId,
        channelSuggestionPayload.token,
      );
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }
    const handoffPayload = this.parseGiveawayHandoffStartPayload(startPayload);
    if (handoffPayload) {
      session.selectedChatId = handoffPayload.chatId;
      session.selectedEntityType = handoffPayload.entityType;
      session.managedGiveawayId = handoffPayload.giveawayId;
      session.entityTab = handoffPayload.entityType;
      session.uiMode = 'modern';
      session.screen = 'giveaway';
      session.section = null;
      session.channelSection = null;
      session.searchQuery = null;
      session.pendingInput = { kind: 'giveaway_content' };
      session.pendingMassAction = null;
      session.lastScreenStack = [];
    }
    session.screen =
      session.selectedChatId === null
        ? 'home'
        : session.screen === 'chat_select'
          ? this.resolvePrimaryScreen(session)
          : session.screen;
    const preserveRulesTextPrompt =
      startPayload === RULES_HANDOFF_START_PAYLOAD && session.pendingInput?.kind === 'rules_text';
    if (
      session.pendingInput?.kind !== 'channel_suggestion' &&
      session.pendingInput?.kind !== 'broadcast_content' &&
      session.pendingInput?.kind !== 'giveaway_content' &&
      !preserveRulesTextPrompt
    ) {
      session.pendingInput = null;
    }
    session.pendingMassAction = null;

    if (
      handoffPayload &&
      wasPrivateHandoffRecentlyDelivered(
        session,
        'giveaway',
        context.chatId,
        GIVEAWAY_HANDOFF_DEDUP_WINDOW_MS,
      )
    ) {
      clearPrivateHandoffDelivery(session, 'giveaway');
      await this.saveSession(context.actor.userId, session);
      return;
    }

    if (
      startPayload === BROADCAST_HANDOFF_START_PAYLOAD &&
      wasPrivateHandoffRecentlyDelivered(
        session,
        'broadcast',
        context.chatId,
        BROADCAST_HANDOFF_DEDUP_WINDOW_MS,
      )
    ) {
      clearPrivateHandoffDelivery(session, 'broadcast');
      await this.saveSession(context.actor.userId, session);
      return;
    }

    if (
      startPayload === RULES_HANDOFF_START_PAYLOAD &&
      wasPrivateHandoffRecentlyDelivered(
        session,
        'rules',
        context.chatId,
        RULES_HANDOFF_DEDUP_WINDOW_MS,
      )
    ) {
      clearPrivateHandoffDelivery(session, 'rules');
      await this.saveSession(context.actor.userId, session);
      return;
    }

    const isPlainStart = typeof startPayload !== 'string' || startPayload.trim().length === 0;
    const shouldShowLauncherIntro =
      isPlainStart && !(await this.hasDeliveredLauncherIntro(context.actor.userId));
    const view = shouldShowLauncherIntro
      ? this.renderLauncherIntroView()
      : await this.renderByCurrentScreen(context, session);

    await this.respond(context, session, view, {
      callbackId: null,
      notification: null,
    });

    if (shouldShowLauncherIntro) {
      await this.markLauncherIntroDelivered(context.actor.userId);
    }
  }

  async handoffKaravanStorefrontAllowlistFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<{ botUrl: string }> {
    const chatId = sourceChatId.trim();
    if (!chatId) {
      throw new BadRequestException('Не указан чат для списка разрешённых пользователей.');
    }
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    if (!this.karavanStorefrontAllowlistService) {
      throw new BadRequestException('Список разрешённых пользователей временно недоступен.');
    }

    const session = await this.loadSession(user.userId);
    const existing = session.pendingKaravanAllowlist;
    if (existing && existing.expiresAt > Date.now()) {
      throw new BadRequestException(
        'Сначала завершите текущее добавление пользователя или нажмите «Отмена».',
      );
    }

    const chatTitle = await this.resolveKaravanAllowlistChatTitle(chatId, user);

    const botId = user.launchBotId?.trim() || session.lastPrivateBotId?.trim() || null;
    const nonce = this.createKaravanAllowlistNonce();
    const startPayload = this.buildKaravanAllowlistStartPayload(
      { chatId, actorUserId: user.userId, nonce },
      botId,
    );
    const botUrl = this.buildBotStartUrl(startPayload, botId);
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    session.pendingKaravanAllowlist = {
      chatId,
      chatTitle,
      actorUserId: user.userId,
      botId,
      nonce,
      stage: 'await_forward',
      targetUserId: null,
      targetDisplayName: null,
      sourceMessageId: null,
      expiresAt: Date.now() + KARAVAN_ALLOWLIST_FLOW_TTL_MS,
    };
    await this.saveSession(user.userId, session);
    return karavanStorefrontHandoffResponseSchema.parse({ botUrl });
  }

  private async handleKaravanAllowlistStarted(
    context: PrivateContext,
    start: { chatId: string; actorUserId: string; nonce: string },
  ): Promise<void> {
    const session = await this.loadSession(context.actor.userId);
    this.rememberPrivateChatRoute(session, context);
    const flow = session.pendingKaravanAllowlist;
    const currentBotId = this.sessionBotContext.currentBotId();
    const bound = Boolean(
      flow &&
      flow.chatId === start.chatId &&
      flow.actorUserId === start.actorUserId &&
      flow.actorUserId === context.actor.userId &&
      flow.nonce === start.nonce &&
      (!flow.botId || !currentBotId || flow.botId === currentBotId),
    );
    if (!flow || !bound) {
      await this.sendImmediate(
        context.chatId,
        'Ссылка добавления устарела или уже использована. Вернитесь в настройки чата и запустите добавление ещё раз.',
        undefined,
        this.resolvePrivateDeliveryBotId(context, session),
      );
      return;
    }
    if (flow.expiresAt <= Date.now()) {
      session.pendingKaravanAllowlist = null;
      await this.respond(context, session, this.renderKaravanAllowlistExpiredView(), {
        callbackId: null,
        notification: null,
      });
      return;
    }

    await this.ensureKaravanAllowlistChatTitle(flow, context.actor);

    flow.stage = 'await_forward';
    await this.respond(
      context,
      session,
      this.renderKaravanAllowlistForwardPrompt(flow.chatId, undefined, flow.nonce, flow.chatTitle),
      {
        callbackId: null,
        notification: null,
      },
    );
  }

  private async processKaravanAllowlistText(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<boolean> {
    const flow = session.pendingKaravanAllowlist;
    if (!flow) return false;
    if (flow.actorUserId !== context.actor.userId) {
      return false;
    }
    if (flow.expiresAt <= Date.now()) {
      session.pendingKaravanAllowlist = null;
      await this.respond(context, session, this.renderKaravanAllowlistExpiredView(), {
        callbackId: null,
        notification: null,
      });
      return true;
    }

    if (context.text.trim().toLowerCase() === 'отмена') {
      session.pendingKaravanAllowlist = null;
      await this.respond(context, session, this.renderKaravanAllowlistCancelledView(), {
        callbackId: null,
        notification: 'Отменено',
      });
      return true;
    }

    await this.ensureKaravanAllowlistChatTitle(flow, context.actor);

    if (flow.stage !== 'await_forward') {
      await this.respond(context, session, this.renderKaravanAllowlistDurationPrompt(flow), {
        callbackId: null,
        notification: 'Выберите срок кнопкой ниже',
      });
      return true;
    }

    const targets = dedupePrivateForwardedModerationTargets(
      extractForwardedModerationTargets(context.update, null, {
        messageNodeMode: 'incoming-message',
        readPrivateForwardedFields: true,
      }),
    );
    if (targets.length !== 1) {
      await this.respond(
        context,
        session,
        this.renderKaravanAllowlistForwardPrompt(
          flow.chatId,
          targets.length > 1
            ? 'Перешлите одно сообщение пользователя.'
            : 'Не удалось определить пользователя. Перешлите сообщение пользователя, которому хотите выдать доступ.',
          flow.nonce,
          flow.chatTitle,
        ),
        { callbackId: null, notification: 'Нужно переслать сообщение пользователя' },
      );
      return true;
    }

    const target = targets[0]!;
    if (!target.userId.trim() || target.userId.trim() === context.actor.userId.trim()) {
      await this.respond(
        context,
        session,
        this.renderKaravanAllowlistForwardPrompt(
          flow.chatId,
          'Не удалось определить пользователя. Перешлите сообщение пользователя, которому хотите выдать доступ.',
          flow.nonce,
          flow.chatTitle,
        ),
        { callbackId: null, notification: 'Пользователь не распознан' },
      );
      return true;
    }

    flow.stage = 'await_duration';
    flow.targetUserId = target.userId.trim();
    flow.targetDisplayName = target.senderName?.trim() || null;
    flow.sourceMessageId = target.messageId?.trim() || null;
    await this.respond(context, session, this.renderKaravanAllowlistDurationPrompt(flow), {
      callbackId: null,
      notification: 'Пользователь найден',
    });
    return true;
  }

  private async processKaravanAllowlistCallback(
    context: PrivateContext,
    session: PrivateSession,
    callback: CallbackAction,
  ): Promise<void> {
    const flow = session.pendingKaravanAllowlist;
    if (!flow || flow.actorUserId !== context.actor.userId) {
      await this.respond(context, session, this.renderKaravanAllowlistExpiredView(), {
        callbackId: context.callbackId,
        notification: 'Сценарий устарел',
      });
      return;
    }
    if (callback.action === KARAVAN_ALLOWLIST_CANCEL_CALLBACK_ACTION) {
      if (callback.args[0] !== flow.nonce) {
        await this.respond(context, session, this.renderKaravanAllowlistExpiredView(), {
          callbackId: context.callbackId,
          notification: 'Кнопка устарела',
        });
        return;
      }
      session.pendingKaravanAllowlist = null;
      await this.respond(context, session, this.renderKaravanAllowlistCancelledView(), {
        callbackId: context.callbackId,
        notification: 'Отменено',
      });
      return;
    }
    if (flow.expiresAt <= Date.now() || flow.stage !== 'await_duration') {
      session.pendingKaravanAllowlist = null;
      await this.respond(context, session, this.renderKaravanAllowlistExpiredView(), {
        callbackId: context.callbackId,
        notification: 'Сценарий устарел',
      });
      return;
    }
    const nonce = callback.args[0]?.trim() ?? '';
    const parsedDuration = karavanStorefrontDurationSchema.safeParse(callback.args[1]);
    if (!nonce || nonce !== flow.nonce || !parsedDuration.success || !flow.targetUserId) {
      await this.respond(context, session, this.renderKaravanAllowlistDurationPrompt(flow), {
        callbackId: context.callbackId,
        notification: 'Кнопка устарела',
      });
      return;
    }
    if (!this.karavanStorefrontAllowlistService) {
      throw new BadRequestException('Список разрешённых пользователей временно недоступен.');
    }

    const lockKey = `karavan-storefront-allowlist:grant:${flow.actorUserId}:${flow.nonce}`;
    const lockToken = this.redisCounter
      ? await this.redisCounter.acquireLock(lockKey, 15_000)
      : 'memory';
    if (!lockToken) {
      await this.respond(context, session, this.renderKaravanAllowlistExpiredView(), {
        callbackId: context.callbackId,
        notification: 'Операция уже выполняется',
      });
      return;
    }
    try {
      await this.adminService.assertManagedEntityAdminAccess(
        flow.chatId,
        context.actor.userId,
        'chat',
      );
      const expiresAt = resolveKaravanStorefrontExpiresAt(parsedDuration.data);
      await this.karavanStorefrontAllowlistService.upsert({
        chatId: flow.chatId,
        userId: flow.targetUserId,
        displayName: flow.targetDisplayName,
        expiresAt,
        createdByUserId: context.actor.userId,
        sourceMessageId: flow.sourceMessageId,
      });
      session.pendingKaravanAllowlist = null;
      await this.respond(
        context,
        session,
        this.renderKaravanAllowlistGrantedView(flow, expiresAt),
        { callbackId: context.callbackId, notification: 'Доступ сохранён' },
      );
    } finally {
      if (this.redisCounter && lockToken !== 'memory') {
        await this.redisCounter.releaseLock(lockKey, lockToken).catch(() => undefined);
      }
    }
  }

  private renderKaravanAllowlistForwardPrompt(
    chatId: string,
    notice?: string,
    nonce?: string,
    chatTitle?: string | null,
  ): PrivateView {
    const readableChatTitle = formatKaravanAllowlistChatTitle(chatId, chatTitle);
    return {
      text: [
        privateMarkdownTitle('Разрешение для витрины'),
        '',
        notice
          ? escapePrivateMarkdown(notice)
          : 'Перешлите сообщение пользователя, которому хотите выдать доступ.',
        `Чат: ${escapePrivateMarkdown(readableChatTitle)}`,
        '',
        'Сообщение можно переслать из любого чата.',
        'Для отмены напишите «отмена».',
      ].join('\n'),
      options: {
        buttons: [
          [
            this.callbackButton(
              'Отмена',
              this.cb(KARAVAN_ALLOWLIST_CANCEL_CALLBACK_ACTION, nonce ?? ''),
            ),
          ],
        ],
      },
    };
  }

  private renderKaravanAllowlistDurationPrompt(flow: PendingKaravanAllowlistFlow): PrivateView {
    const label = flow.targetDisplayName?.trim() || 'Пользователь';
    const chatTitle = formatKaravanAllowlistChatTitle(flow.chatId, flow.chatTitle);
    return {
      text: [
        privateMarkdownTitle('Срок разрешения'),
        '',
        `Пользователь: ${escapePrivateMarkdown(label)}`,
        `Чат: ${escapePrivateMarkdown(chatTitle)}`,
        '',
        'Выберите срок публикации витрин:',
      ].join('\n'),
      options: {
        buttons: [
          [
            this.callbackButton(
              '1 день',
              this.cb(KARAVAN_ALLOWLIST_CALLBACK_ACTION, flow.nonce, '1d'),
            ),
            this.callbackButton(
              '7 дней',
              this.cb(KARAVAN_ALLOWLIST_CALLBACK_ACTION, flow.nonce, '7d'),
            ),
          ],
          [
            this.callbackButton(
              '30 дней',
              this.cb(KARAVAN_ALLOWLIST_CALLBACK_ACTION, flow.nonce, '30d'),
            ),
            this.callbackButton(
              '90 дней',
              this.cb(KARAVAN_ALLOWLIST_CALLBACK_ACTION, flow.nonce, '90d'),
            ),
          ],
          [
            this.callbackButton(
              'Бессрочно',
              this.cb(KARAVAN_ALLOWLIST_CALLBACK_ACTION, flow.nonce, 'forever'),
              'positive',
            ),
          ],
          [
            this.callbackButton(
              'Отмена',
              this.cb(KARAVAN_ALLOWLIST_CANCEL_CALLBACK_ACTION, flow.nonce),
              'negative',
            ),
          ],
        ],
      },
    };
  }

  private renderKaravanAllowlistGrantedView(
    flow: PendingKaravanAllowlistFlow,
    expiresAt: Date | null,
  ): PrivateView {
    return {
      text: [
        privateMarkdownTitle('Доступ разрешён'),
        '',
        `Пользователь: ${escapePrivateMarkdown(flow.targetDisplayName?.trim() || 'Пользователь')}`,
        `Чат: ${escapePrivateMarkdown(formatKaravanAllowlistChatTitle(flow.chatId, flow.chatTitle))}`,
        `Срок: ${expiresAt ? formatPrivateControlDateTimeLabel(expiresAt.toISOString()) : 'бессрочно'}`,
      ].join('\n'),
      options: { buttons: this.buildFooterButtons() },
    };
  }

  private renderKaravanAllowlistExpiredView(): PrivateView {
    return {
      text: [
        privateMarkdownTitle('Сценарий завершён'),
        '',
        'Вернитесь в настройки чата и запустите добавление пользователя ещё раз.',
      ].join('\n'),
      options: { buttons: this.buildFooterButtons() },
    };
  }

  private renderKaravanAllowlistCancelledView(): PrivateView {
    return {
      text: [
        privateMarkdownTitle('Добавление отменено'),
        '',
        'Список разрешённых пользователей не изменён.',
      ].join('\n'),
      options: { buttons: this.buildFooterButtons() },
    };
  }

  private resolveKaravanAllowlistChatTitle(chatId: string, user: AuthUser): Promise<string> {
    return resolveKaravanAllowlistChatTitle({
      chatId,
      user,
      loadHeader: (targetChatId, actor) =>
        this.adminService.getChatHeader(targetChatId, actor, {
          skipAdminCheck: true,
          skipEntityCheck: true,
        }),
    });
  }

  private async ensureKaravanAllowlistChatTitle(
    flow: PendingKaravanAllowlistFlow,
    user: AuthUser,
  ): Promise<void> {
    if (isPresentableKaravanAllowlistChatTitle(flow.chatId, flow.chatTitle)) {
      return;
    }

    flow.chatTitle = await this.resolveKaravanAllowlistChatTitle(flow.chatId, user);
  }

  async handoffBroadcastFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
    } else {
      await this.adminService.getSettings(sourceChatId, user);
    }

    const parsed = broadcastHandoffRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const session = await this.loadSession(user.userId);
    const hasMatchingDraft =
      session.selectedChatId === sourceChatId && session.selectedEntityType === entityType;
    const preservedDraft = hasMatchingDraft
      ? normalizePrivateBroadcastDraft(session.broadcastDraft)
      : DEFAULT_BROADCAST_DRAFT;
    const hasPreservedContent =
      preservedDraft.text.trim().length > 0 || preservedDraft.imageEnabled;
    session.selectedChatId = sourceChatId;
    session.selectedEntityType = entityType;
    session.managedGiveawayId = null;
    session.entityTab = entityType;
    session.uiMode = 'modern';
    session.screen = 'broadcast';
    session.section = null;
    session.channelSection = null;
    session.searchQuery = null;
    session.broadcastView = 'advanced';
    session.pendingMassAction = null;
    session.pendingInput = hasPreservedContent ? null : { kind: 'broadcast_content' };
    const scheduleMode: BroadcastScheduleMode =
      parsed.data.scheduleMode === 'calendar' ? 'calendar' : 'legacy';
    const targetState = resolvePrivateBroadcastDraftTargetState({
      targetMode: entityType === 'channel' ? 'current' : parsed.data.targetMode,
      targetChatIds: parsed.data.targetChatIds,
      applyToAllChats: entityType === 'channel' ? false : parsed.data.applyToAllChats,
      fallbackChatId: sourceChatId,
    });
    session.broadcastDraft = {
      ...DEFAULT_BROADCAST_DRAFT,
      text: preservedDraft.text,
      textFormat: preservedDraft.textFormat,
      imageEnabled: preservedDraft.imageEnabled,
      imageBase64: preservedDraft.imageBase64,
      imageMimeType: preservedDraft.imageMimeType,
      imageFileName: preservedDraft.imageFileName,
      targetMode: targetState.targetMode,
      targetChatIds: targetState.targetChatIds,
      applyToAllChats: targetState.applyToAllChats,
      buttons: parsed.data.buttons,
      buttonEnabled: parsed.data.buttonEnabled,
      buttonUrl: parsed.data.buttonEnabled ? parsed.data.buttonUrl.trim() : '',
      buttonText: parsed.data.buttonEnabled
        ? parsed.data.buttonText.trim() || DEFAULT_BROADCAST_BUTTON_TEXT
        : DEFAULT_BROADCAST_DRAFT.buttonText,
      scheduleMode,
      scheduleTimezone:
        parsed.data.scheduleTimezone.trim() || DEFAULT_BROADCAST_DRAFT.scheduleTimezone,
      scheduledSlots:
        scheduleMode === 'calendar'
          ? Array.from(
              new Set(parsed.data.scheduledSlots.map((slot) => slot.trim()).filter(Boolean)),
            ).sort((left, right) => left.localeCompare(right))
          : [],
      sendAt: scheduleMode === 'calendar' ? null : parsed.data.sendAt,
      cycleEnabled: scheduleMode === 'calendar' ? false : parsed.data.cycleEnabled,
      cycleEveryHours:
        scheduleMode === 'calendar'
          ? DEFAULT_BROADCAST_DRAFT.cycleEveryHours
          : !parsed.data.cycleEnabled
            ? 24
            : parsed.data.cycleEveryHours,
      cycleCount:
        scheduleMode === 'calendar'
          ? Math.max(1, parsed.data.scheduledSlots.length)
          : !parsed.data.cycleEnabled
            ? 1
            : parsed.data.cycleCount,
    };

    await this.saveSession(user.userId, session);
    await this.deliverBroadcastHandoffToKnownPrivateChat(user, session);

    const handoffBotId = session.lastPrivateBotId?.trim() || null;
    const botUrl = this.buildBotStartUrl(BROADCAST_HANDOFF_START_PAYLOAD, handoffBotId);
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  async getBroadcastHandoffState(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffState> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
    } else {
      await this.adminService.getSettings(sourceChatId, user);
    }

    const session = await this.loadSession(user.userId);
    const hasMatchingDraft =
      session.selectedChatId === sourceChatId && session.selectedEntityType === entityType;
    const draft = hasMatchingDraft ? session.broadcastDraft : DEFAULT_BROADCAST_DRAFT;

    return this.buildBroadcastHandoffState(entityType, draft);
  }

  async clearBroadcastHandoffState(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffState> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
    } else {
      await this.adminService.getSettings(sourceChatId, user);
    }

    const session = await this.loadSession(user.userId);
    if (session.selectedChatId === sourceChatId && session.selectedEntityType === entityType) {
      session.broadcastDraft = clonePrivateBroadcastDraft(DEFAULT_BROADCAST_DRAFT);
      session.pendingInput = null;
      if (session.pendingMassAction?.kind === 'broadcast') {
        session.pendingMassAction = null;
      }
      await this.saveSession(user.userId, session);
    }

    await rememberBroadcastComposerClientReset(
      this.redisCounter,
      user.userId,
      entityType,
      sourceChatId,
    );

    return this.buildBroadcastHandoffState(entityType, DEFAULT_BROADCAST_DRAFT);
  }

  async getBroadcastComposerClientResetState(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<{ resetAt: string | null }> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
    } else {
      await this.adminService.getSettings(sourceChatId, user);
    }

    if (!this.redisCounter) {
      return { resetAt: null };
    }

    const resetAt = await this.redisCounter.getString(
      buildBroadcastComposerClientResetKey(user.userId, entityType, sourceChatId),
    );
    return {
      resetAt: normalizeBroadcastComposerClientResetValue(resetAt),
    };
  }

  async handoffRulesFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
  ): Promise<BroadcastHandoffResponse> {
    await this.adminService.getRules(sourceChatId, user);

    const session = await this.loadSession(user.userId);
    session.selectedChatId = sourceChatId;
    session.selectedEntityType = 'chat';
    session.managedGiveawayId = null;
    session.entityTab = 'chat';
    session.uiMode = 'modern';
    session.screen = 'rules';
    session.section = null;
    session.channelSection = null;
    session.searchQuery = null;
    session.pendingMassAction = null;
    session.pendingInput = { kind: 'rules_text' };
    session.lastScreenStack = [];

    const handoffBotId = preparePrivateHandoffBot(
      session,
      this.sessionBotContext.currentBotId() ?? user.launchBotId,
    );
    await this.saveSession(user.userId, session);
    await this.deliverRulesHandoffToKnownPrivateChat(user, session);

    const botUrl = this.buildBotStartUrl(RULES_HANDOFF_START_PAYLOAD, handoffBotId);
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  async openChannelSuggestionFromCallback(params: {
    userId: string;
    chatId: string;
    token: string;
    botId?: string | null;
  }): Promise<boolean> {
    const session = await this.loadSession(params.userId);
    const botId =
      typeof params.botId === 'string' && params.botId.trim() ? params.botId.trim() : null;
    if (botId) {
      session.lastPrivateBotId = botId;
    }
    session.pendingInput = {
      kind: 'channel_suggestion',
      chatId: params.chatId,
      token: params.token,
    };
    session.suggestionDraft = null;
    session.pendingMassAction = null;
    session.managedGiveawayId = null;
    session.section = null;
    session.channelSection = null;
    session.searchQuery = null;
    session.lastScreenStack = [];

    await this.saveSession(params.userId, session);

    const view = await this.renderChannelSuggestionIntroView(params.chatId, params.token);
    const text = limitPrivateControlMessageText(view.text);
    const compactOptions = this.compactButtonLayout(view.options);
    const inferredTextFormat =
      compactOptions?.textFormat ?? (this.shouldUseMarkdown(text) ? 'markdown' : undefined);
    const optionsWithFormat = inferredTextFormat
      ? { ...(compactOptions ?? {}), textFormat: inferredTextFormat }
      : compactOptions;
    const options = this.withDebugContext(optionsWithFormat, session, 'suggest_callback_handoff');

    try {
      await this.maxClient.sendMessageImmediateToUser(
        params.userId,
        text,
        options,
        botId ? { botId } : {},
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId: params.userId,
          chatId: params.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to open channel suggestion in private bot chat',
      );
      return false;
    }
  }

  async handoffGiveawayFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
    } else {
      await this.adminService.getSettings(sourceChatId, user);
    }

    const parsed = managedGiveawayHandoffRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    if (parsed.data.giveawayId) {
      await this.managedGiveawayService.getManagedGiveaway(
        sourceChatId,
        parsed.data.giveawayId,
        user,
        entityType,
      );
    }

    const session = await this.loadSession(user.userId);
    session.selectedChatId = sourceChatId;
    session.selectedEntityType = entityType;
    session.managedGiveawayId = parsed.data.giveawayId;
    session.entityTab = entityType;
    session.uiMode = 'modern';
    session.screen = 'giveaway';
    session.section = null;
    session.channelSection = null;
    session.searchQuery = null;
    session.pendingMassAction = null;
    session.pendingInput = { kind: 'giveaway_content' };
    session.lastScreenStack = [];

    const handoffBotId = preparePrivateHandoffBot(
      session,
      this.sessionBotContext.currentBotId() ?? user.launchBotId,
    );
    await this.saveSession(user.userId, session);
    await this.deliverGiveawayHandoffToKnownPrivateChat(user, session);

    const botUrl = this.buildBotStartUrl(
      this.buildGiveawayHandoffStartPayload(
        {
          chatId: sourceChatId,
          entityType,
          giveawayId: parsed.data.giveawayId,
        },
        handoffBotId,
      ),
      handoffBotId,
    );
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  async handoffProfileMentionFromMiniapp(
    sourceChatId: string,
    user: AuthUser,
    targetUserId: string,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<BroadcastHandoffResponse> {
    const parsed = profileMentionHandoffRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalizedTargetUserId = targetUserId.trim();
    if (!normalizedTargetUserId) {
      throw new BadRequestException('Не указан пользователь для открытия профиля.');
    }

    const header =
      entityType === 'channel'
        ? await this.adminService.getChannelHeader(sourceChatId, user)
        : await this.adminService.getChatHeader(sourceChatId, user);
    const profileLookupBotId = this.resolveManagedEntityHeaderBotId(header);

    let resolvedDisplayName = parsed.data.displayName;
    try {
      const profiles = profileLookupBotId
        ? await this.maxClient.getChatMemberProfiles(sourceChatId, [normalizedTargetUserId], {
            botId: profileLookupBotId,
          })
        : await this.maxClient.getChatMemberProfiles(sourceChatId, [normalizedTargetUserId]);
      const profile = profiles.get(normalizedTargetUserId);
      const displayName = readPrivateControlString(profile?.displayName);
      if (displayName) {
        resolvedDisplayName = displayName;
        await this.persistResolvedProfileDisplayName(
          sourceChatId,
          normalizedTargetUserId,
          displayName,
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          chatId: sourceChatId,
          entityType,
          targetUserId: normalizedTargetUserId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve profile handoff display name from MAX',
      );
    }

    const session = await this.loadSession(user.userId);
    const handoffBotId = preparePrivateHandoffBot(
      session,
      this.sessionBotContext.currentBotId() ?? user.launchBotId,
    );
    const botUrl = this.buildBotStartUrl(
      this.buildProfileMentionStartPayload(
        {
          chatId: sourceChatId,
          entityType,
          userId: normalizedTargetUserId,
          displayName: resolvedDisplayName,
        },
        handoffBotId,
      ),
      handoffBotId,
    );
    if (!botUrl) {
      throw new BadRequestException('Ссылка на личный чат бота не настроена.');
    }

    rememberPendingPrivateProfileMentionHandoff(session, {
      chatId: sourceChatId,
      displayName: resolvedDisplayName,
      userId: normalizedTargetUserId,
    });
    await this.saveSession(user.userId, session);
    await this.deliverProfileMentionHandoffToKnownPrivateChat(user, session, {
      displayName: resolvedDisplayName,
      userId: normalizedTargetUserId,
    });

    return broadcastHandoffResponseSchema.parse({ botUrl });
  }

  private async processTextMessage(context: PrivateContext): Promise<void> {
    const session = await this.loadSession(context.actor.userId);
    this.rememberPrivateChatRoute(session, context);
    if (this.hasRetiredPublishingSession(session)) {
      await this.respond(context, session, this.renderPublikHandoff(session), {
        callbackId: null,
        notification: null,
      });
      return;
    }
    if (session.pendingKaravanAllowlist) {
      await this.processKaravanAllowlistText(context, session);
      return;
    }
    const directText = this.extractDirectIncomingText(context.update);
    const forwardedModerationCommand = parsePrivateForwardedModerationCommand(directText);
    if (forwardedModerationCommand) {
      if (forwardedModerationCommand.action === 'RULES') {
        const forwardedRulesSources = extractPrivateForwardedRulesSources(context.update);
        if (forwardedRulesSources.length > 0) {
          await this.handleForwardedRulesCommand(context, session, forwardedRulesSources);
          return;
        }
      } else {
        const forwardedTargets = extractPrivateForwardedModerationTargets(context.update);
        if (forwardedTargets.length > 0) {
          await this.handleForwardedModerationCommand(
            context,
            session,
            forwardedTargets,
            forwardedModerationCommand,
          );
          return;
        }
      }
    }

    const imageSourceAttachment = extractPrivateFirstImageSourceAttachment(context.update);
    const fileAttachment = extractPrivateFirstFileAttachment(context.update);
    const hasVideoAttachment = hasPrivateVideoAttachment(context.update);

    if (session.pendingInput) {
      await this.processPendingInput(context, session);
      return;
    }

    if (
      session.screen === 'broadcast' &&
      session.selectedChatId &&
      (context.text.trim().length > 0 || imageSourceAttachment !== null || hasVideoAttachment)
    ) {
      await this.captureBroadcastContent(context, session, context.text);
      const view = await this.renderBroadcastScreen(context, session, 'Контент сохранён.');
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (
      session.screen === 'giveaway' &&
      session.selectedChatId &&
      session.selectedEntityType &&
      !context.text.trim().startsWith('/') &&
      (context.text.trim().length > 0 ||
        imageSourceAttachment !== null ||
        hasVideoAttachment ||
        fileAttachment !== null)
    ) {
      const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
      if (giveaway?.status === 'DRAFT') {
        const notice = await this.captureGiveawayContent(context, session, context.text);
        const view = await this.renderGiveawayContentFollowUp(context, session, notice);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }
    }

    if (
      session.screen === 'rules' &&
      session.selectedChatId &&
      session.selectedEntityType !== 'channel' &&
      !context.text.trim().startsWith('/') &&
      (context.text.trim().length > 0 ||
        imageSourceAttachment !== null ||
        hasVideoAttachment ||
        fileAttachment !== null)
    ) {
      const view = await this.renderRulesScreen(
        context,
        session,
        'Сначала нажмите «Изменить текст» или «Добавить фото».',
      );
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    if (context.text.trim().startsWith('/')) {
      const view = await this.renderPrimaryScreen(context, session);

      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    const view = await this.renderPrimaryScreen(context, session);

    await this.respond(context, session, view, {
      callbackId: null,
      notification: null,
    });
  }

  private async handleForwardedModerationCommand(
    context: PrivateContext,
    session: PrivateSession,
    targets: ForwardedModerationTarget[],
    command: ForwardedModerationActionCommand,
  ): Promise<void> {
    const uniqueTargets = dedupePrivateForwardedModerationTargets(targets);
    if (uniqueTargets.length !== 1) {
      throw new BadRequestException(
        'Перешлите ровно одно сообщение из нужного чата и добавьте команду «бан» или «мут».',
      );
    }

    const target = uniqueTargets[0];
    const result =
      command.action === 'BAN'
        ? await this.manualModerationService.applyManualSystemBan(
            target.chatId,
            target.userId,
            context.actor,
            'private_command',
          )
        : await this.manualModerationService.applyManualModerationAction(
            target.chatId,
            target.userId,
            context.actor,
            {
              action: 'MUTE',
              ...(command.mutePermanent
                ? { mutePermanent: true }
                : { muteDurationHours: command.muteDurationHours }),
            },
            'private_command',
          );

    await this.saveSession(context.actor.userId, session);

    const targetLabel = target.senderName
      ? `${target.senderName} (${target.userId})`
      : target.userId;
    const chatLabel = target.chatTitle ? target.chatTitle : target.chatId;
    const lines =
      command.action === 'BAN'
        ? [`Бан включён для: ${targetLabel}`, `Чат: ${chatLabel}`]
        : [result.message, `Чат: ${chatLabel}`, `Участник: ${targetLabel}`];
    await this.sendImmediate(
      context.chatId,
      lines.join('\n'),
      undefined,
      this.resolvePrivateDeliveryBotId(context, session),
    );
  }

  private async handleForwardedRulesCommand(
    context: PrivateContext,
    session: PrivateSession,
    sources: ForwardedRulesSource[],
  ): Promise<void> {
    const uniqueSources = dedupePrivateForwardedRulesSources(sources);
    if (uniqueSources.length !== 1) {
      throw new BadRequestException(
        'Перешлите одно сообщение из нужной группы одним сообщением и добавьте слово «правило» или «правила».',
      );
    }

    const sourceMessage = uniqueSources[0];
    const result = await this.manualModerationService.adoptChatRulesFromMessage(
      sourceMessage.chatId,
      context.actor,
      {
        sourceMessageId: sourceMessage.messageId,
        sourceMessageUrl: sourceMessage.url,
        text: sourceMessage.text,
      },
      'private_command',
    );

    await this.saveSession(context.actor.userId, session);

    const chatLabel = sourceMessage.chatTitle ? sourceMessage.chatTitle : sourceMessage.chatId;
    const lines = ['Правила привязаны к сообщению.', `Чат: ${chatLabel}`];
    if (result.publishedUrl) {
      lines.push(`Пост: ${result.publishedUrl}`);
    }
    lines.push('Кнопка «Правила» в нарушениях включена.');
    await this.sendImmediate(
      context.chatId,
      lines.join('\n'),
      undefined,
      this.resolvePrivateDeliveryBotId(context, session),
    );
  }

  private async startSupportRequestFlow(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<void> {
    session.uiMode = 'modern';
    session.pendingInput = { kind: 'support_request' };
    session.pendingMassAction = null;

    const view = this.renderSupportRequestPrompt();
    await this.respond(context, session, view, {
      callbackId: context.callbackId,
      notification: 'Жду описание проблемы',
    });
  }

  private async captureSupportRequest(
    context: PrivateContext,
    session: PrivateSession,
    rawText: string,
  ): Promise<void> {
    if (!this.supportRequestsService) {
      throw new BadRequestException('Сейчас обращение не удалось принять. Попробуйте позже.');
    }

    const attachments = await this.buildSupportRequestAttachments(context, session);
    const text = rawText.trim();
    if (!text && attachments.length === 0) {
      throw new BadRequestException('Пришлите текст проблемы или фото.');
    }

    await this.supportRequestsService.createRequest({
      botId:
        this.resolvePrivateDeliveryBotId(context, session) ??
        this.maxBotLinkService?.getContextOrDefaultBotId() ??
        this.botDeepLinkId,
      privateChatId: context.chatId,
      userId: context.actor.userId,
      userName: context.actor.displayName ?? context.actor.username ?? null,
      messageId: context.update.message?.messageId ?? null,
      text,
      attachments,
    });

    session.pendingInput = null;
    const view = this.renderSupportRequestSubmittedView();
    await this.respond(context, session, view, {
      callbackId: null,
      notification: null,
    });
  }

  private renderSupportRequestPrompt(): PrivateView {
    return {
      text: [
        privateMarkdownTitle('Сообщить о проблеме'),
        '',
        'Опишите проблему одним сообщением. Можно приложить фото.',
        'Для отмены напишите «отмена».',
      ].join('\n'),
      options: {
        buttons: [[this.callbackButton('Отмена', this.cb('input_cancel'))]],
      },
    };
  }

  private renderSupportRequestSubmittedView(): PrivateView {
    return {
      text: [
        privateMarkdownTitle('Обращение передано'),
        '',
        'Спасибо. Посмотрю и вернусь с ответом при необходимости.',
      ].join('\n'),
      options: {
        buttons: this.buildFooterButtons(),
      },
    };
  }

  private async buildSupportRequestAttachments(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<SupportRequestAttachment[]> {
    const imageSources = extractPrivateImageSourceAttachments(context.update).slice(0, 5);
    const uploader = this.buildPrivateControlMediaUploader(context, session);
    const attachments: SupportRequestAttachment[] = [];

    for (const imageSource of imageSources) {
      const source = imageSource.attachment;
      let payload: Record<string, unknown> | null = null;
      try {
        const draft = await buildPrivateSuggestionMediaDraftFromImage(
          imageSource,
          uploader,
          'support-request',
        );
        payload = draft.payload;
      } catch (error: unknown) {
        this.logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to upload support request image',
        );
      }

      attachments.push({
        type: 'image',
        fileName: 'fileName' in source ? source.fileName : null,
        mimeType: source.mimeType,
        url: source.url,
        payload,
      });
    }

    if (attachments.length > 0) {
      return attachments;
    }

    for (const rawAttachment of collectPrivateMessageAttachments(context.update).slice(0, 5)) {
      const rawType =
        typeof rawAttachment.type === 'string' ? rawAttachment.type.trim().toLowerCase() : '';
      if (rawType === 'image' || rawType === 'file') {
        continue;
      }

      attachments.push({
        type: rawType === 'video' ? 'video' : 'unknown',
        fileName:
          readPrivateControlString(rawAttachment.file_name ?? rawAttachment.fileName) ?? null,
        mimeType: null,
        url: null,
        payload: null,
      });
    }

    return attachments;
  }

  private extractDirectIncomingText(update: MaxUpdate): string {
    const messageNode = extractIncomingMessageNode(update);
    if (!messageNode) {
      return '';
    }

    const body = asPrivateControlRecord(messageNode.body);
    const content = asPrivateControlRecord(messageNode.content);
    const payload = asPrivateControlRecord(messageNode.payload);
    const nestedMessage = asPrivateControlRecord(messageNode.message);
    const candidates = [
      messageNode.text,
      messageNode.caption,
      messageNode.message_text,
      messageNode.messageText,
      body?.text,
      body?.caption,
      body?.plain,
      content?.text,
      content?.caption,
      payload?.text,
      payload?.caption,
      nestedMessage?.text,
      nestedMessage?.caption,
    ];

    for (const candidate of candidates) {
      const value = readPrivateControlString(candidate);
      if (value) {
        return value;
      }
    }

    return '';
  }

  private async processChannelSuggestionEditCallback(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<void> {
    const draft = session.suggestionDraft;
    if (!draft) {
      const view = this.renderChannelSuggestionCancelledView();
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Черновик не найден',
      });
      return;
    }

    const botId = this.resolvePrivateDeliveryBotId(context, session);
    assertPrivateSuggestionMediaBot(draft, botId);
    await this.clearChannelSuggestionPreviewButtons(context.chatId, draft.previewMessageId, botId);
    draft.previewMessageId = null;
    session.pendingInput = {
      kind: 'channel_suggestion',
      chatId: draft.chatId,
      token: draft.token,
    };

    const view = this.renderInputPrompt(session.pendingInput);
    await this.respond(context, session, view, {
      callbackId: context.callbackId,
      notification: 'Пришлите новый текст или медиа',
    });
  }

  private async processChannelSuggestionSendCallback(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<void> {
    const draft = session.suggestionDraft;
    if (!draft) {
      const view = this.renderChannelSuggestionCancelledView();
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Черновик уже закрыт',
      });
      return;
    }

    const botId = this.resolvePrivateDeliveryBotId(context, session);
    assertPrivateSuggestionMediaBot(draft, botId);
    await this.clearChannelSuggestionPreviewButtons(context.chatId, draft.previewMessageId, botId);
    draft.previewMessageId = null;

    let result: Awaited<ReturnType<AdminService['createChannelSuggestionFromBot']>>;
    try {
      result = await this.adminService.createChannelSuggestionFromBot(
        draft.chatId,
        context.actor,
        buildPrivateChannelSuggestionSubmissionPayload(draft),
        { mediaBotId: draft.mediaBotId },
      );
    } catch (error: unknown) {
      await this.sendChannelSuggestionDraftPreview(context, session);
      throw error;
    }

    session.pendingInput = null;
    this.clearChannelSuggestionDraft(session);

    const view = result.delivered
      ? await this.renderChannelSuggestionSubmittedView(draft.chatId, draft.token)
      : result.queued
        ? await this.renderChannelSuggestionQueuedView(draft.chatId, draft.token)
        : await this.renderChannelSuggestionUndeliveredView(draft.chatId, draft.token);
    await this.respond(context, session, view, {
      callbackId: context.callbackId,
      notification: result.delivered
        ? 'Отправлено редакторам'
        : result.queued
          ? 'Поставлено в очередь'
          : 'Сохранено, доставка не подтверждена',
    });
  }

  private async processChannelSuggestionAgainCallback(
    context: PrivateContext,
    session: PrivateSession,
    args: string[],
  ): Promise<void> {
    const chatId = args[0]?.trim() ?? '';
    const token = args[1]?.trim() ?? '';
    if (!chatId || !token) {
      throw new BadRequestException('Не удалось открыть новую предложку.');
    }

    session.pendingInput = {
      kind: 'channel_suggestion',
      chatId,
      token,
    };
    session.suggestionDraft = null;

    const view = await this.renderChannelSuggestionIntroView(chatId, token);
    await this.respond(context, session, view, {
      callbackId: context.callbackId,
      notification: 'Жду новый вариант',
    });
  }

  private async processChannelSuggestionComposeCallback(
    context: PrivateContext,
    session: PrivateSession,
    args: string[],
  ): Promise<void> {
    const chatId = args[0]?.trim() ?? '';
    const token = args[1]?.trim() ?? '';
    if (!chatId || !token) {
      throw new BadRequestException('Не удалось открыть ввод контента.');
    }

    session.pendingInput = {
      kind: 'channel_suggestion',
      chatId,
      token,
    };
    session.suggestionDraft = null;

    const view: PrivateView = {
      text: [
        privateMarkdownTitle('✍️ Добавьте контент'),
        '',
        '⬇️ Пришлите следующим сообщением текст, фото, видео или подпись к медиа.',
        'Можно отправить несколько сообщений подряд: бот будет обновлять пример публикации после каждого нового текста.',
        `Фото будут добавляться в одну предложку до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} шт., а новое видео заменит текущие медиа.`,
      ].join('\n'),
      options: {
        buttons: [[await this.buildChannelSuggestionReturnButton(chatId)]],
      },
    };
    await this.respond(context, session, view, {
      callbackId: context.callbackId,
      notification: 'Жду текст, фото или видео',
    });
  }

  private async processChannelSuggestionReviewCallback(
    context: PrivateContext,
    session: PrivateSession,
    action: 'publish' | 'cancel',
    args: string[],
  ): Promise<void> {
    const suggestionId = args[0]?.trim() ?? '';
    if (!suggestionId) {
      throw new BadRequestException('Не удалось определить предложку.');
    }

    const result = await this.adminService
      .reviewChannelSuggestionByAdmin(suggestionId, context.actor, action)
      .catch((error: unknown) => {
        throw new BadRequestException(describePrivateSuggestionReviewError(error));
      });
    if (result.reviewStatus === 'processing') {
      // FLAG: A pending callback must not overwrite a concurrently finalized admin card.
      await this.saveSession(context.actor.userId, session);
      if (context.callbackId) {
        await this.answerCallbackQuiet(
          context.callbackId,
          'Предложка обрабатывается. Результат пока не подтверждён.',
          this.privateCallbackAckTimeoutMs,
          this.resolvePrivateDeliveryBotId(context, session),
          context.chatId,
        );
      }
      return;
    }
    const publishedUrl = result.publishedUrl?.trim() ?? '';
    const view: PrivateView =
      result.reviewStatus === 'published'
        ? {
            text: [
              privateMarkdownTitle('✅ Предложка опубликована'),
              '',
              ...(publishedUrl ? [`Пост: [Открыть пост](${publishedUrl})`, ''] : []),
              'Решение сохранено.',
            ].join('\n'),
            ...(publishedUrl
              ? {
                  options: {
                    buttons: [
                      [
                        {
                          type: 'link',
                          text: 'Открыть пост',
                          url: publishedUrl,
                        },
                      ],
                    ],
                  },
                }
              : {}),
          }
        : {
            text: [privateMarkdownTitle('✖️ Предложка отклонена'), '', 'Решение сохранено.'].join(
              '\n',
            ),
          };

    await this.respond(context, session, view, {
      callbackId: context.callbackId,
      notification:
        result.status === 'already_reviewed'
          ? result.reviewStatus === 'published'
            ? 'Уже опубликовано'
            : 'Уже отменено'
          : result.status === 'review_in_progress'
            ? 'Уже обрабатывается'
            : result.reviewStatus === 'published'
              ? 'Пост опубликован'
              : 'Предложка отменена',
    });
  }

  private async processCallback(context: PrivateContext): Promise<void> {
    const callback = this.parseCallbackAction(context.callbackPayload);
    const session = await this.loadSession(context.actor.userId);
    this.rememberPrivateChatRoute(session, context);

    if (
      callback &&
      (callback.action === 'open_broadcast' ||
        callback.action.startsWith('broadcast_') ||
        MINIAPP_BROADCAST_SETTINGS_CALLBACK_ACTIONS.has(callback.action) ||
        (this.hasRetiredPublishingSession(session) &&
          ['mass_confirm', 'mass_cancel', 'input_cancel', 'back'].includes(callback.action)))
    ) {
      await this.respond(context, session, this.renderPublikHandoff(session), {
        callbackId: context.callbackId,
        notification: 'Посты и автопостинг теперь в Публике',
      });
      return;
    }

    if (!callback) {
      const view = session.selectedChatId
        ? await this.renderPrimaryScreen(context, session)
        : await this.renderChatSelection(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: this.isStaleLegacyCallbackPayload(context.callbackPayload)
          ? CALLBACK_STALE_NOTIFICATION
          : CALLBACK_REFRESH_NOTIFICATION,
      });
      return;
    }

    if (callback.action === 'giveaway_claim_confirm') {
      const giveawayId = callback.args[0] ?? '';
      const winnerId = callback.args[1] ?? '';
      if (!giveawayId || !winnerId) {
        throw new BadRequestException('Не удалось определить подтверждение приза.');
      }

      const currentClaim = await this.managedGiveawayService.getGiveawayClaimContext(
        giveawayId,
        winnerId,
        context.actor.userId,
      );
      if (!currentClaim) {
        const view = this.renderUnavailableGiveawayClaimView();
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Экран обновлён',
        });
        return;
      }

      if (currentClaim.winner.status !== 'SELECTED') {
        const view = this.renderGiveawayClaimView(
          currentClaim,
          'Подтверждение больше не требуется.',
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Подтверждение больше не нужно',
        });
        return;
      }

      await this.managedGiveawayService.claimGiveaway(giveawayId, context.actor, 'private_claim');
      const refreshedClaim = await this.managedGiveawayService.getGiveawayClaimContext(
        giveawayId,
        winnerId,
        context.actor.userId,
      );
      const view = refreshedClaim
        ? this.renderGiveawayClaimView(refreshedClaim, 'Приз подтверждён.')
        : this.renderUnavailableGiveawayClaimView();
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Приз подтверждён',
      });
      return;
    }

    if (
      callback.action === KARAVAN_ALLOWLIST_CALLBACK_ACTION ||
      callback.action === KARAVAN_ALLOWLIST_CANCEL_CALLBACK_ACTION
    ) {
      await this.processKaravanAllowlistCallback(context, session, callback);
      return;
    }

    if (session.pendingKaravanAllowlist) {
      await this.ensureKaravanAllowlistChatTitle(session.pendingKaravanAllowlist, context.actor);
      const view =
        session.pendingKaravanAllowlist.stage === 'await_duration'
          ? this.renderKaravanAllowlistDurationPrompt(session.pendingKaravanAllowlist)
          : this.renderKaravanAllowlistForwardPrompt(
              session.pendingKaravanAllowlist.chatId,
              undefined,
              session.pendingKaravanAllowlist.nonce,
              session.pendingKaravanAllowlist.chatTitle,
            );
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Сначала завершите добавление пользователя',
      });
      return;
    }

    if (callback.action === 'suggestion_edit') {
      await this.processChannelSuggestionEditCallback(context, session);
      return;
    }

    if (callback.action === 'suggestion_send') {
      await this.processChannelSuggestionSendCallback(context, session);
      return;
    }

    if (callback.action === 'suggestion_compose') {
      await this.processChannelSuggestionComposeCallback(context, session, callback.args);
      return;
    }

    if (callback.action === 'suggestion_again') {
      await this.processChannelSuggestionAgainCallback(context, session, callback.args);
      return;
    }

    if (callback.action === 'suggestion_review_publish') {
      await this.processChannelSuggestionReviewCallback(context, session, 'publish', callback.args);
      return;
    }

    if (callback.action === 'suggestion_review_cancel') {
      await this.processChannelSuggestionReviewCallback(context, session, 'cancel', callback.args);
      return;
    }

    if (callback.action === 'support_report') {
      await this.startSupportRequestFlow(context, session);
      return;
    }

    if (
      session.pendingMassAction &&
      !['mass_cancel', 'mass_confirm', 'main', 'home', 'help'].includes(callback.action)
    ) {
      const view = this.renderMassActionConfirmation(session.pendingMassAction);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Сначала подтвердите или отмените действие',
      });
      return;
    }

    if (
      session.pendingInput &&
      session.pendingInput.kind !== 'broadcast_content' &&
      session.pendingInput.kind !== 'giveaway_content' &&
      callback.action !== 'input_cancel'
    ) {
      const view = this.renderInputPrompt(session.pendingInput);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Сначала завершите ввод или нажмите «Отмена»',
      });
      return;
    }

    if (CHAT_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.assertSelectedEntityType(session, 'chat');
    }

    if (CHANNEL_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.assertSelectedEntityType(session, 'channel');
    }

    if (
      !session.selectedChatId &&
      (CHAT_ONLY_CALLBACK_ACTIONS.has(callback.action) ||
        CHANNEL_ONLY_CALLBACK_ACTIONS.has(callback.action) ||
        ENTITY_CALLBACK_ACTIONS.has(callback.action) ||
        MINIAPP_SETTINGS_ONLY_CALLBACK_ACTIONS.has(callback.action) ||
        MINIAPP_ACTIVITY_ONLY_CALLBACK_ACTIONS.has(callback.action) ||
        MINIAPP_CHANNEL_SETTINGS_CALLBACK_ACTIONS.has(callback.action) ||
        MINIAPP_GIVEAWAY_ONLY_CALLBACK_ACTIONS.has(callback.action) ||
        MINIAPP_RULES_ONLY_CALLBACK_ACTIONS.has(callback.action) ||
        MINIAPP_BROADCAST_SETTINGS_CALLBACK_ACTIONS.has(callback.action))
    ) {
      this.resetSessionToPrimaryScreen(session);
      const view = this.renderLauncherHomeView(
        'Контекст чата не сохранён. Откройте нужный чат или канал в приложении и запустите действие ещё раз.',
      );
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Откройте нужный чат в приложении',
      });
      return;
    }

    if (MINIAPP_SETTINGS_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.resetSessionToPrimaryScreen(session);
      const view = await this.renderEntitySettingsMovedToMiniappScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Настройки перенесены в mini app',
      });
      return;
    }

    if (MINIAPP_ACTIVITY_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.resetSessionToPrimaryScreen(session);
      const view = await this.renderEntityActivityMovedToMiniappScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Открывайте активность в mini app',
      });
      return;
    }

    if (MINIAPP_CHANNEL_SETTINGS_CALLBACK_ACTIONS.has(callback.action)) {
      this.resetSessionToPrimaryScreen(session);
      const view = await this.renderEntityChannelSettingsMovedToMiniappScreen(
        context,
        session,
        callback.args[0],
      );
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Открывайте настройки канала в mini app',
      });
      return;
    }

    if (MINIAPP_GIVEAWAY_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.resetSessionToPrimaryScreen(session);
      const view = await this.renderEntityGiveawayMovedToMiniappScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Розыгрыши открываются в mini app',
      });
      return;
    }

    if (MINIAPP_RULES_ONLY_CALLBACK_ACTIONS.has(callback.action)) {
      this.resetSessionToPrimaryScreen(session);
      const view = await this.renderEntityRulesMovedToMiniappScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Дополнительные настройки правил перенесены в mini app',
      });
      return;
    }

    if (MINIAPP_BROADCAST_SETTINGS_CALLBACK_ACTIONS.has(callback.action)) {
      this.resetSessionToPrimaryScreen(session);
      const view = await this.renderEntityBroadcastMovedToMiniappScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: context.callbackId,
        notification: 'Параметры автопостинга открываются в mini app',
      });
      return;
    }

    switch (callback.action) {
      case 'home': {
        session.uiMode = 'modern';
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.managedGiveawayId = null;
        session.section = null;
        session.channelSection = null;
        session.searchQuery = null;
        session.lastScreenStack = [];
        session.screen = this.resolvePrimaryScreen(session);
        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Главный экран',
        });
        return;
      }

      case 'home_tab': {
        const tab = callback.args[0] === 'all' ? 'all' : 'quick';
        const view =
          tab === 'all'
            ? await this.renderSettingsHubScreen(context, {
                ...session,
                screen: 'settings_hub',
              })
            : await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: tab === 'all' ? 'Разделы настроек' : 'Главный экран',
        });
        return;
      }

      case 'back': {
        const restored = this.restoreFromHistory(session);
        const view = restored
          ? await this.renderByCurrentScreen(context, session)
          : await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Назад',
        });
        return;
      }

      case 'help': {
        session.uiMode = 'modern';
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.managedGiveawayId = null;
        session.section = null;
        session.channelSection = null;
        session.searchQuery = null;
        session.lastScreenStack = [];
        session.screen = this.resolvePrimaryScreen(session);
        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Главный экран',
        });
        return;
      }

      case 'chat_page': {
        session.chatPage = toPrivateControlPositiveInt(callback.args[0], 1);
        session.screen = 'home';
        const view = this.renderLauncherHomeView('Выбирайте чат и канал в приложении.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Выбор доступен в приложении',
        });
        return;
      }

      case 'entity_tab': {
        session.entityTab = callback.args[0] === 'channel' ? 'channel' : 'chat';
        session.chatPage = 1;
        session.screen = 'home';
        const view = this.renderLauncherHomeView(
          'Переключение между чатами и каналами доступно в приложении.',
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Откройте приложение',
        });
        return;
      }

      case 'chat_refresh': {
        session.chatPage = 1;
        session.screen = 'home';
        const view = this.renderLauncherHomeView(
          'Список чатов и каналов обновляется в приложении.',
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Обновляйте список в приложении',
        });
        return;
      }

      case 'chat_select': {
        const hasExplicitType = callback.args.length >= 2;
        const selectedEntityType: ManagedEntityType =
          hasExplicitType && callback.args[0] === 'channel' ? 'channel' : 'chat';
        const chatId = hasExplicitType ? (callback.args[1] ?? '') : (callback.args[0] ?? '');
        if (!chatId) {
          throw new BadRequestException('chatId is required');
        }

        session.selectedChatId = chatId;
        session.selectedEntityType = selectedEntityType;
        session.managedGiveawayId = null;
        session.entityTab = selectedEntityType;
        session.screen = this.resolvePrimaryScreen(session);
        session.section = null;
        session.channelSection = null;
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.searchQuery = null;
        session.homeTab = 'quick';
        session.sectionView = 'basic';
        session.lastScreenStack = [];
        session.eventsPage = 1;
        session.domainPage = 1;
        session.manualPage = 1;
        session.manualTargetUserId = null;

        const view = await this.renderEntitySettingsMovedToMiniappScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification:
            selectedEntityType === 'channel' ? 'Канал открыт в mini app' : 'Чат открыт в mini app',
        });
        return;
      }

      case 'change_chat': {
        session.screen = 'home';
        session.selectedChatId = null;
        session.selectedEntityType = null;
        session.managedGiveawayId = null;
        session.chatPage = 1;
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.searchQuery = null;
        session.channelSection = null;
        session.lastScreenStack = [];
        const view = this.renderLauncherHomeView('Выбирайте чат и канал в приложении.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Откройте приложение',
        });
        return;
      }

      case 'main': {
        session.screen = this.resolvePrimaryScreen(session);
        session.section = null;
        session.channelSection = null;
        session.pendingInput = null;
        session.pendingMassAction = null;
        session.sectionView = 'basic';
        session.searchQuery = null;
        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Главный экран',
        });
        return;
      }

      case 'open_settings_hub': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'settings_hub';
        session.section = null;
        session.channelSection = null;
        session.pendingInput = null;
        session.pendingMassAction = null;
        const view = await this.renderSettingsHubScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Разделы настроек',
        });
        return;
      }

      case 'open_rules': {
        this.assertSelectedEntityType(session, 'chat');
        this.pushHistory(session);
        session.screen = 'rules';
        session.pendingInput = null;
        session.pendingMassAction = null;
        const view = await this.renderRulesScreen(context, session);
        await this.respondWithFreshMessage(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Правила чата',
        });
        return;
      }

      case 'open_channel_section': {
        const section = this.parseChannelSection(callback.args[0]);
        if (!section) {
          throw new BadRequestException('Unknown channel section');
        }

        this.assertSelectedEntityType(session, 'channel');
        this.pushHistory(session);
        session.screen = 'channel_section';
        session.channelSection = section;
        session.section = null;
        session.pendingInput = null;
        session.pendingMassAction = null;

        const view = await this.renderChannelSectionScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: CHANNEL_SECTION_LABELS[section],
        });
        return;
      }

      case 'toggle_channel': {
        const section = this.parseChannelSection(callback.args[0]);
        const key = callback.args[1] as keyof ChannelSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Unknown channel setting toggle');
        }

        this.assertSelectedEntityType(session, 'channel');
        const config = this.findChannelFieldConfig(section, key);
        if (!config || config.type !== 'boolean') {
          throw new BadRequestException('Setting is not toggle');
        }

        const current = await this.adminService.getChannelSettings(
          session.selectedChatId!,
          context.actor,
        );
        const nextValue = !(current[key] as boolean);
        await this.updateSingleChannelSetting(
          session.selectedChatId!,
          context.actor,
          key,
          nextValue,
        );

        const view = await this.renderChannelSectionScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${nextValue ? 'включено' : 'выключено'}`,
        });
        return;
      }

      case 'set_channel_input': {
        const section = this.parseChannelSection(callback.args[0]);
        const key = callback.args[1] as keyof ChannelSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Input payload is invalid');
        }

        this.assertSelectedEntityType(session, 'channel');
        const config = this.findChannelFieldConfig(section, key);
        if (!config || config.type === 'boolean' || config.type === 'enum') {
          throw new BadRequestException('Setting does not support text input');
        }

        session.pendingInput = {
          kind: 'set_channel_field',
          section,
          key,
          type: config.type,
          min: config.min,
          max: config.max,
        };

        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Жду значение: ${config.label}`,
        });
        return;
      }

      case 'publish_channel_engagement': {
        this.assertSelectedEntityType(session, 'channel');
        const chatId = session.selectedChatId;
        if (!chatId) {
          throw new BadRequestException('Channel is not selected');
        }
        const settings = await this.adminService.getChannelSettings(chatId, context.actor);
        const request = this.buildChannelEngagementPublishRequest(settings);

        await this.adminService.publishChannelEngagementMessage(chatId, context.actor, request);

        const view = await this.renderChannelHomeScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Пост с кнопками опубликован',
        });
        return;
      }

      case 'open_section': {
        const section = this.parseSection(callback.args[0]);
        if (!section) {
          throw new BadRequestException('Unknown section');
        }

        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'section';
        session.section = section;
        session.channelSection = null;
        session.sectionView = 'basic';
        session.pendingInput = null;
        session.pendingMassAction = null;

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: SECTION_LABELS[section],
        });
        return;
      }

      case 'toggle': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Unknown setting toggle');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (!config || config.type !== 'boolean') {
          throw new BadRequestException('Setting is not toggle');
        }

        const current = await this.adminService.getSettings(session.selectedChatId!, context.actor);
        const nextValue = !(current[key] as boolean);
        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, nextValue);

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${nextValue ? 'включено' : 'выключено'}`,
        });
        return;
      }

      case 'set_enum': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        const value = callback.args[2] ?? '';
        if (!section || !key || !value) {
          throw new BadRequestException('Enum payload is invalid');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (!config || config.type !== 'enum' || !config.enumValues?.includes(value)) {
          throw new BadRequestException('Unknown enum value');
        }

        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, value);
        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${value}`,
        });
        return;
      }

      case 'set_number_preset': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        const rawValue = callback.args[2] ?? '';
        if (!section || !key) {
          throw new BadRequestException('Number preset payload is invalid');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (!config || config.type !== 'number') {
          throw new BadRequestException('Setting does not support presets');
        }

        const nextValue = Number(rawValue);
        if (!Number.isFinite(nextValue) || Number.isNaN(nextValue)) {
          throw new BadRequestException('Preset is invalid');
        }
        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, nextValue);

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${settingsRenderer.formatNumberPreset(config, nextValue)}`,
        });
        return;
      }

      case 'step_number': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        const rawDelta = callback.args[2] ?? '';
        if (!section || !key) {
          throw new BadRequestException('Number step payload is invalid');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (!config || config.type !== 'number') {
          throw new BadRequestException('Setting does not support stepper');
        }

        const delta = Number(rawDelta);
        if (!Number.isFinite(delta) || Number.isNaN(delta)) {
          throw new BadRequestException('Delta is invalid');
        }

        const current = await this.adminService.getSettings(session.selectedChatId!, context.actor);
        const currentValue = Number(current[key] ?? 0);
        const bounded =
          key === 'deleteBotMessagesDelayMinutes' || key === 'greetingDeleteBotMessageDelayMinutes'
            ? stepDeleteBotMessagesDelayMinutes(currentValue, delta)
            : Math.max(
                config.min ?? Number.MIN_SAFE_INTEGER,
                Math.min(config.max ?? Number.MAX_SAFE_INTEGER, currentValue + delta),
              );
        await this.updateSingleSetting(session.selectedChatId!, context.actor, key, bounded);

        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `${config.label}: ${settingsRenderer.formatNumberPreset(config, bounded)}`,
        });
        return;
      }

      case 'set_input': {
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Input payload is invalid');
        }

        this.assertChatSelected(session);
        const config = this.findFieldConfig(section, key);
        if (
          !config ||
          config.type === 'boolean' ||
          config.type === 'enum' ||
          config.type === 'number'
        ) {
          throw new BadRequestException('Setting does not support text input');
        }

        session.pendingInput = {
          kind: 'set_field',
          section,
          key,
          type: config.type,
          min: config.min,
          max: config.max,
        };

        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Жду значение: ${config.label}`,
        });
        return;
      }

      case 'section_view': {
        const section = this.parseSection(callback.args[0]);
        const requestedView = callback.args[1] === 'advanced' ? 'advanced' : 'basic';
        if (!section) {
          throw new BadRequestException('Section is required');
        }

        this.assertChatSelected(session);
        session.section = section;
        session.screen = 'section';
        session.sectionView = requestedView;
        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: requestedView === 'advanced' ? 'Ещё параметры' : 'Основное',
        });
        return;
      }

      case 'open_search': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.pendingInput = { kind: 'search_settings' };
        session.screen = 'search';
        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Найти настройку',
        });
        return;
      }

      case 'search_jump': {
        this.assertChatSelected(session);
        const section = this.parseSection(callback.args[0]);
        const key = callback.args[1] as keyof ChatSettings | undefined;
        if (!section || !key) {
          throw new BadRequestException('Jump payload is invalid');
        }

        this.pushHistory(session);
        session.section = section;
        session.screen = 'section';
        session.sectionView = settingsRenderer.resolveSectionViewForField(section, key);
        const view = await this.renderSectionCardScreen(context, session, section);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открыт параметр',
        });
        return;
      }

      case 'apply_section_preview': {
        const section = this.parseSection(callback.args[0]);
        if (!section) {
          throw new BadRequestException('Section is required');
        }

        this.assertChatSelected(session);
        const availableChats = await this.adminService.listChats(context.actor);
        const targetChats = Array.from(
          new Set([session.selectedChatId!, ...availableChats.map((chat) => chat.id)]),
        ).length;

        session.pendingMassAction = {
          kind: 'apply_section',
          section,
          targetChats,
        };

        const view = this.renderMassActionConfirmation(session.pendingMassAction);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Показываю подтверждение',
        });
        return;
      }

      case 'mass_cancel': {
        const pendingMassAction = session.pendingMassAction;
        session.pendingMassAction = null;

        if (session.section) {
          const view = await this.renderSectionCardScreen(context, session, session.section);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Массовое действие отменено',
          });
          return;
        }

        if (pendingMassAction?.kind === 'broadcast') {
          const view = await this.renderBroadcastScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Автопостинг отменён',
          });
          return;
        }

        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Отменено',
        });
        return;
      }

      case 'mass_confirm': {
        this.assertChatSelected(session);

        if (!session.pendingMassAction) {
          const view = await this.renderPrimaryScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: CALLBACK_REFRESH_NOTIFICATION,
          });
          return;
        }

        if (session.pendingMassAction.kind === 'apply_section') {
          const section = session.pendingMassAction.section;
          const settings = await this.adminService.getSettings(
            session.selectedChatId!,
            context.actor,
          );
          const result = await this.adminService.applySettingsToAllChats(
            session.selectedChatId!,
            context.actor,
            settings,
            'private_bot',
            SECTION_SETTING_KEYS[section],
          );

          session.pendingMassAction = null;
          const view = await this.renderSectionCardScreen(context, session, section);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: `Готово: применено в ${result.updatedChats} чатах`,
          });
          return;
        }

        if (session.pendingMassAction.kind === 'broadcast') {
          const publishClaim = this.claimBroadcastPublish(session);
          if (publishClaim === 'active' || publishClaim === 'recent') {
            const notice =
              publishClaim === 'active'
                ? 'Этот автопостинг уже отправляется.'
                : 'Этот автопостинг уже был запущен.';
            session.pendingMassAction = null;
            const view = await this.renderBroadcastScreen(context, session, notice);
            await this.respond(context, session, view, {
              callbackId: context.callbackId,
              notification:
                publishClaim === 'active'
                  ? 'Автопостинг уже отправляется'
                  : 'Повторная отправка пропущена',
            });
            return;
          }

          const selectedChatId = session.selectedChatId!;
          const selectedEntityType = session.selectedEntityType === 'channel' ? 'channel' : 'chat';
          const broadcastDraft = clonePrivateBroadcastDraft(session.broadcastDraft);
          const diagnostics = {
            callbackAction: 'mass_confirm',
            callbackArgs: [] as string[],
            callbackPayload: 'pc2|mass_confirm',
            screen: session.screen ?? null,
            pendingInput: session.pendingInput?.kind ?? null,
            pendingMassAction: session.pendingMassAction?.kind ?? null,
          };
          session.pendingMassAction = null;
          const view = this.renderBroadcastLaunchingView(session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Запускаю автопостинг',
          });
          void this.finishConfirmedBroadcastPublish({
            privateChatId: context.chatId,
            privateBotId: this.resolvePrivateDeliveryBotId(context, session),
            actor: context.actor,
            selectedChatId,
            selectedEntityType,
            broadcastDraft,
            publishClaim,
            diagnostics,
          });
          return;
        }

        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: CALLBACK_REFRESH_NOTIFICATION,
        });
        return;
      }

      case 'open_domains': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'domains';
        session.domainPage = 1;
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Разрешённые домены',
        });
        return;
      }

      case 'domains_page': {
        this.assertChatSelected(session);
        session.screen = 'domains';
        session.domainPage = toPrivateControlPositiveInt(callback.args[0], 1);
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Страница доменов',
        });
        return;
      }

      case 'domain_add_prompt': {
        this.assertChatSelected(session);
        session.pendingInput = { kind: 'add_domain' };
        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду ссылку или домен',
        });
        return;
      }

      case 'domain_remove': {
        this.assertChatSelected(session);
        const index = toPrivateControlPositiveInt(callback.args[0], 1) - 1;
        const domains = await this.adminService.getDomainAllowlistDetails(
          session.selectedChatId!,
          context.actor,
        );
        if (!domains[index]) {
          throw new BadRequestException('Домен не найден в списке');
        }

        await this.adminService.removeDomain(
          session.selectedChatId!,
          context.actor,
          domains[index].normalizedValue,
          'private_bot',
        );

        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Удалено: ${formatPrivateControlAllowlistEntryLabel(domains[index])}`,
        });
        return;
      }

      case 'domain_schedule_prompt': {
        this.assertChatSelected(session);
        const index = toPrivateControlPositiveInt(callback.args[0], 1) - 1;
        const domains = await this.adminService.getDomainAllowlistDetails(
          session.selectedChatId!,
          context.actor,
        );
        if (!domains[index]) {
          throw new BadRequestException('Домен не найден в списке');
        }

        session.pendingInput = {
          kind: 'schedule_domain',
          domain: domains[index].normalizedValue,
          domainLabel: formatPrivateControlAllowlistEntryLabel(domains[index]),
        };

        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду дату удаления',
        });
        return;
      }

      case 'rules_input_prompt': {
        this.assertSelectedEntityType(session, 'chat');
        const mode = callback.args[0] ?? '';
        if (mode === 'text') {
          session.pendingInput = { kind: 'rules_text' };
        } else if (mode === 'photo') {
          session.pendingInput = { kind: 'rules_photo' };
        } else {
          throw new BadRequestException('Неизвестный режим редактирования правил.');
        }

        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session);
        await this.respondWithFreshMessage(context, session, view, {
          callbackId: context.callbackId,
          notification: mode === 'photo' ? 'Жду фото правил' : 'Жду текст правил',
        });
        return;
      }

      case 'rules_autofill': {
        this.assertSelectedEntityType(session, 'chat');
        const settingsScreen = await this.adminService.getChatSettingsScreen(
          session.selectedChatId!,
          context.actor,
        );
        const generatedText = this.buildRulesTextFromSettings(settingsScreen);

        await this.adminSettingsService.updateRules(
          session.selectedChatId!,
          context.actor,
          buildPrivateChatRulesDraft(settingsScreen.rules, {
            text: generatedText,
            textFormat: 'plain',
            autoTextEnabled: true,
          }),
          'private_bot',
        );
        session.pendingInput = null;
        session.screen = 'rules';
        const view = await this.renderRulesScreen(
          context,
          session,
          'Текст собран из текущих настроек.',
        );
        await this.respondWithFreshMessage(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Текст собран',
        });
        return;
      }

      case 'rules_clear_photo': {
        this.assertSelectedEntityType(session, 'chat');
        const rules = await this.adminService.getRules(session.selectedChatId!, context.actor);
        await this.adminSettingsService.updateRules(
          session.selectedChatId!,
          context.actor,
          buildPrivateChatRulesDraft(rules, {
            imageBase64: '',
            imageMimeType: '',
            imageFileName: '',
          }),
          'private_bot',
        );
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, 'Фото правил убрано.');
        await this.respondWithFreshMessage(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Фото убрано',
        });
        return;
      }

      case 'rules_toggle_attach': {
        this.assertSelectedEntityType(session, 'chat');
        const current = await this.adminService.getSettings(session.selectedChatId!, context.actor);
        const nextSettings: ChatSettings = {
          ...current,
          rulesAttachViolationsEnabled: !current.rulesAttachViolationsEnabled,
        };
        await this.adminService.updateSettings(
          session.selectedChatId!,
          context.actor,
          nextSettings,
          'private_bot',
        );
        session.screen = 'rules';
        const view = await this.renderRulesScreen(
          context,
          session,
          nextSettings.rulesAttachViolationsEnabled
            ? 'Кнопка «Правила» включена.'
            : 'Кнопка «Правила» выключена.',
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: nextSettings.rulesAttachViolationsEnabled
            ? 'Кнопка включена'
            : 'Кнопка выключена',
        });
        return;
      }

      case 'rules_publish': {
        this.assertSelectedEntityType(session, 'chat');
        const notice = await publishPrivateRules(
          this.adminService,
          session.selectedChatId!,
          context.actor,
        );
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, notice.text);
        await this.respondWithFreshMessage(context, session, view, {
          callbackId: context.callbackId,
          notification: notice.notification,
        });
        return;
      }

      case 'rules_reset_publication': {
        this.assertSelectedEntityType(session, 'chat');
        await this.adminService.resetPublishedRules(
          session.selectedChatId!,
          context.actor,
          'private_bot',
        );
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, 'Публикация правил сброшена.');
        await this.respondWithFreshMessage(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Публикация сброшена',
        });
        return;
      }

      case 'open_giveaway': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        this.pushHistory(session);
        session.screen = 'giveaway';
        session.managedGiveawayId = null;
        const view = await this.renderGiveawayScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю розыгрыши',
        });
        return;
      }

      case 'refresh_giveaway': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Экран обновлён',
        });
        return;
      }

      case 'giveaway_create': {
        this.assertSelectedEntityType(
          session,
          (session.selectedEntityType ?? 'chat') as ManagedEntityType,
        );

        const existing = await this.managedGiveawayService.getCurrentManagedGiveawayForEntity(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
        );
        const created =
          existing ??
          (await this.createManagedGiveawayDraftForSession(
            session.selectedChatId,
            context.actor,
            session.selectedEntityType,
          ));
        session.screen = 'giveaway';
        session.managedGiveawayId = created.id;
        const view = await this.renderGiveawayScreen(
          context,
          session,
          existing ? 'Открыт текущий черновик.' : 'Черновик создан.',
        );
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: existing ? 'Открываю черновик' : 'Черновик создан',
        });
        return;
      }

      case 'giveaway_input_prompt': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        session.managedGiveawayId = draft.id;

        const field = callback.args[0] ?? '';
        if (field === 'title') {
          session.pendingInput = { kind: 'giveaway_title' };
        } else if (field === 'content') {
          session.pendingInput = { kind: 'giveaway_content' };
        } else if (field === 'description') {
          session.pendingInput = { kind: 'giveaway_description' };
        } else if (field === 'start_at') {
          session.pendingInput = { kind: 'giveaway_start_at' };
        } else if (field === 'end_at') {
          session.pendingInput = { kind: 'giveaway_end_at' };
        } else if (field === 'claim_hours') {
          session.pendingInput = { kind: 'giveaway_claim_hours' };
        } else if (field === 'photo') {
          session.pendingInput = { kind: 'giveaway_photo' };
        } else if (field === 'prize') {
          const position = Number.parseInt(callback.args[1] ?? '', 10);
          if (!Number.isInteger(position) || position < 1 || position > draft.prizes.length) {
            throw new BadRequestException('Не удалось определить призовое место.');
          }
          session.pendingInput = { kind: 'giveaway_prize', index: position - 1 };
        } else {
          throw new BadRequestException('Не удалось определить поле розыгрыша.');
        }

        const view =
          session.pendingInput.kind === 'giveaway_content'
            ? await this.renderGiveawayContentPrompt(context, session)
            : this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду ввод',
        });
        return;
      }

      case 'giveaway_clear_start': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.startsAt = null;
          },
        );
        session.managedGiveawayId = saved.id;
        const view = await this.renderGiveawayScreen(context, session, 'Старт убран.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Старт очищен',
        });
        return;
      }

      case 'giveaway_clear_photo': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.imageEnabled = false;
            nextDraft.imageBase64 = '';
            nextDraft.imageMimeType = '';
            nextDraft.imageFileName = '';
          },
        );
        session.managedGiveawayId = saved.id;
        const view = await this.renderGiveawayScreen(context, session, 'Фото убрано.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Фото удалено',
        });
        return;
      }

      case 'giveaway_add_prize': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        if (draft.prizes.length >= MANAGED_GIVEAWAY_MAX_PRIZES) {
          throw new BadRequestException(
            `Можно добавить не больше ${MANAGED_GIVEAWAY_MAX_PRIZES} мест.`,
          );
        }

        session.managedGiveawayId = draft.id;
        session.pendingInput = { kind: 'giveaway_prize', index: draft.prizes.length };
        const view = this.renderInputPrompt(session.pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Введите название приза',
        });
        return;
      }

      case 'giveaway_remove_last_prize': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        if (draft.prizes.length <= 1) {
          throw new BadRequestException('Нужно оставить хотя бы одно призовое место.');
        }

        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.prizes = nextDraft.prizes
              .slice(0, -1)
              .map((prize, index) => ({ ...prize, position: index + 1 }));
          },
        );
        session.managedGiveawayId = saved.id;
        const view = await this.renderGiveawayScreen(context, session, 'Последнее место удалено.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Место удалено',
        });
        return;
      }

      case 'giveaway_publish': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (!giveaway || giveaway.status !== 'DRAFT') {
          throw new BadRequestException('Черновик розыгрыша не найден.');
        }

        await this.managedGiveawayService.publishManagedGiveaway(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        session.pendingInput = null;
        const view = await this.renderGiveawayScreen(context, session, 'Розыгрыш опубликован.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Опубликовано',
        });
        return;
      }

      case 'giveaway_close': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (!giveaway || (giveaway.status !== 'ACTIVE' && giveaway.status !== 'SCHEDULED')) {
          throw new BadRequestException('Нет активного розыгрыша для завершения.');
        }

        await this.managedGiveawayService.closeManagedGiveaway(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Итоги опубликованы.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Розыгрыш завершён',
        });
        return;
      }

      case 'giveaway_cancel': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (
          !giveaway ||
          (giveaway.status !== 'DRAFT' &&
            giveaway.status !== 'ACTIVE' &&
            giveaway.status !== 'SCHEDULED')
        ) {
          throw new BadRequestException('Нет розыгрыша, который можно отменить.');
        }

        await this.managedGiveawayService.cancelManagedGiveaway(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Розыгрыш отменён.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Розыгрыш отменён',
        });
        return;
      }

      case 'giveaway_reroll': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const winnerId = callback.args[0]?.trim();
        if (!winnerId) {
          throw new BadRequestException('Не удалось определить победителя для реролла.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (!giveaway) {
          throw new BadRequestException('Розыгрыш не найден.');
        }

        await this.managedGiveawayService.rerollManagedGiveawayWinner(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          { winnerId },
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Победитель перевыбран.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Реролл выполнен',
        });
        return;
      }

      case 'giveaway_deliver': {
        if (!session.selectedChatId || !session.selectedEntityType) {
          throw new BadRequestException('Сначала выберите чат или канал.');
        }

        const winnerId = callback.args[0]?.trim();
        if (!winnerId) {
          throw new BadRequestException('Не удалось определить победителя для выдачи.');
        }

        const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
        if (!giveaway) {
          throw new BadRequestException('Розыгрыш не найден.');
        }

        await this.managedGiveawayService.markManagedGiveawayWinnerDelivered(
          session.selectedChatId,
          giveaway.id,
          context.actor,
          { winnerId },
          session.selectedEntityType,
          'private_bot',
        );
        session.managedGiveawayId = giveaway.id;
        const view = await this.renderGiveawayScreen(context, session, 'Выдача подтверждена.');
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Статус обновлён',
        });
        return;
      }

      case 'broadcast_input_prompt': {
        this.assertChatSelected(session);
        const flag = callback.args[0] ?? '';
        if (
          flag === 'button_url' ||
          flag === 'button_text' ||
          flag === 'send_at' ||
          flag === 'cycle_hours' ||
          flag === 'cycle_count'
        ) {
          this.resetSessionToPrimaryScreen(session);
          const view = await this.renderEntityBroadcastMovedToMiniappScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Дополнительные параметры открываются в mini app',
          });
          return;
        }

        const pendingInput = this.buildBroadcastPendingInput(
          flag === 'text' || flag === 'photo' ? 'content' : flag,
        );
        if (!pendingInput) {
          throw new BadRequestException('Неизвестный шаг настройки');
        }

        session.pendingInput = pendingInput;
        const view =
          pendingInput.kind === 'broadcast_content'
            ? await this.renderBroadcastScreen(context, session)
            : this.renderInputPrompt(pendingInput);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Жду ввод',
        });
        return;
      }

      case 'broadcast_send': {
        this.assertChatSelected(session);
        const hasContent =
          session.broadcastDraft.text.trim().length > 0 ||
          session.broadcastDraft.imageEnabled ||
          Boolean(session.broadcastDraft.mediaPayload);
        if (!hasContent) {
          session.pendingInput = { kind: 'broadcast_content' };
          const view = this.renderInputPrompt(session.pendingInput);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Сначала пришлите контент',
          });
          return;
        }

        if (session.selectedEntityType !== 'channel') {
          let targetChats = 1;
          if (session.broadcastDraft.targetMode === 'all') {
            const availableChats = await this.adminService.listChatsForMassBroadcast(context.actor);
            targetChats = Array.from(
              new Set([session.selectedChatId!, ...availableChats.map((chat) => chat.id)]),
            ).length;
          } else if (session.broadcastDraft.targetMode === 'selected') {
            targetChats = normalizePrivateBroadcastTargetChatIds(
              session.broadcastDraft.targetChatIds,
            ).length;
          }

          if (targetChats > 1) {
            session.pendingMassAction = {
              kind: 'broadcast',
              targetChats,
            };
            const view = this.renderMassActionConfirmation(session.pendingMassAction);
            await this.respond(context, session, view, {
              callbackId: context.callbackId,
              notification: 'Нужно подтверждение',
            });
            return;
          }
        }

        const publishClaim = this.claimBroadcastPublish(session);
        if (publishClaim === 'active' || publishClaim === 'recent') {
          const notice =
            publishClaim === 'active'
              ? 'Этот автопостинг уже отправляется.'
              : 'Этот автопостинг уже был запущен.';
          const view = await this.renderBroadcastScreen(context, session, notice);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification:
              publishClaim === 'active'
                ? 'Автопостинг уже отправляется'
                : 'Повторная отправка пропущена',
          });
          return;
        }

        const selectedChatId = session.selectedChatId!;
        const selectedEntityType = session.selectedEntityType === 'channel' ? 'channel' : 'chat';
        const broadcastDraft = clonePrivateBroadcastDraft(session.broadcastDraft);
        const diagnostics = {
          callbackAction: 'broadcast_send',
          callbackArgs: [] as string[],
          callbackPayload: 'pc2|broadcast_send',
          screen: session.screen ?? null,
          pendingInput: session.pendingInput?.kind ?? null,
          pendingMassAction: session.pendingMassAction?.kind ?? null,
        };
        const view = this.renderBroadcastLaunchingView(session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Запускаю автопостинг',
        });
        void this.finishConfirmedBroadcastPublish({
          privateChatId: context.chatId,
          privateBotId: this.resolvePrivateDeliveryBotId(context, session),
          actor: context.actor,
          selectedChatId,
          selectedEntityType,
          broadcastDraft,
          publishClaim,
          diagnostics,
        });
        return;
      }

      case 'open_events': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'events';
        session.eventsPage = 1;
        const view = await this.renderEventsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю события',
        });
        return;
      }

      case 'events_page': {
        this.assertChatSelected(session);
        session.screen = 'events';
        session.eventsPage = toPrivateControlPositiveInt(callback.args[0], 1);
        const view = await this.renderEventsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Страница событий',
        });
        return;
      }

      case 'open_logs': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'logs';
        const view = await this.renderLogsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю логи',
        });
        return;
      }

      case 'logs_range': {
        this.assertChatSelected(session);
        const range = parsePrivateControlLogsRange(callback.args[0]);
        session.screen = 'logs';
        session.logsRange = range;
        const view = await this.renderLogsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: `Диапазон: ${range}`,
        });
        return;
      }

      case 'open_manual_users': {
        this.assertChatSelected(session);
        this.pushHistory(session);
        session.screen = 'manual_users';
        session.manualPage = 1;
        session.manualTargetUserId = null;
        const view = await this.renderManualUsersScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Открываю ручную модерацию',
        });
        return;
      }

      case 'manual_users_page': {
        this.assertChatSelected(session);
        session.screen = 'manual_users';
        session.manualPage = toPrivateControlPositiveInt(callback.args[0], 1);
        const view = await this.renderManualUsersScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Показываю участников',
        });
        return;
      }

      case 'manual_select_user': {
        this.assertChatSelected(session);
        const targetUserId = callback.args[0] ?? '';
        if (!targetUserId) {
          throw new BadRequestException('Не указан user_id участника.');
        }

        session.screen = 'manual_actions';
        session.manualTargetUserId = targetUserId;
        const view = this.renderManualActionsScreen(session.manualTargetUserId);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Участник выбран',
        });
        return;
      }

      case 'manual_action': {
        this.assertChatSelected(session);
        const action = (callback.args[0] ?? '').toUpperCase();
        const targetUserId = session.manualTargetUserId;
        if (!targetUserId) {
          throw new BadRequestException('Сначала выберите участника из списка.');
        }

        if (action === 'MUTE') {
          session.pendingInput = {
            kind: 'manual_mute_duration',
            targetUserId,
          };
          const view = this.renderInputPrompt(session.pendingInput);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Жду длительность мута',
          });
          return;
        }

        if (action !== 'BAN' && action !== 'UNMUTE' && action !== 'UNBAN') {
          throw new BadRequestException('Действие не распознано.');
        }

        const result = await this.manualModerationService.applyManualModerationAction(
          session.selectedChatId!,
          targetUserId,
          context.actor,
          {
            action,
          },
          'private_bot',
        );

        const view = this.renderManualActionsScreen(session.manualTargetUserId, result.message);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Готово',
        });
        return;
      }

      case 'input_cancel': {
        const canceledInput = session.pendingInput;
        session.pendingInput = null;
        if (canceledInput?.kind === 'channel_suggestion') {
          if (session.suggestionDraft) {
            await this.sendChannelSuggestionDraftPreview(context, session);
            if (context.callbackId) {
              await this.answerCallbackQuiet(
                context.callbackId,
                'Черновик сохранён',
                undefined,
                this.resolvePrivateDeliveryBotId(context, session),
                context.chatId,
              );
            }
            return;
          }

          const view = this.renderChannelSuggestionCancelledView();
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Предложка закрыта',
          });
          return;
        }

        if (session.screen === 'channel_section' && session.channelSection) {
          const view = await this.renderChannelSectionScreen(
            context,
            session,
            session.channelSection,
          );
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'section' && session.section) {
          const view = await this.renderSectionCardScreen(context, session, session.section);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'broadcast') {
          const view = await this.renderBroadcastScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'giveaway') {
          const view = await this.renderGiveawayScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'domains') {
          const view = await this.renderDomainsScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'rules') {
          const view = await this.renderRulesScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'manual_actions') {
          const view = this.renderManualActionsScreen(session.manualTargetUserId);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        if (session.screen === 'search') {
          session.searchQuery = null;
          const restored = this.restoreFromHistory(session);
          const view = restored
            ? await this.renderByCurrentScreen(context, session)
            : await this.renderPrimaryScreen(context, session);
          await this.respond(context, session, view, {
            callbackId: context.callbackId,
            notification: 'Отменено',
          });
          return;
        }

        const view = await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: 'Отменено',
        });
        return;
      }

      default: {
        const view = session.selectedChatId
          ? await this.renderPrimaryScreen(context, session)
          : await this.renderChatSelection(context, session);
        await this.respond(context, session, view, {
          callbackId: context.callbackId,
          notification: CALLBACK_REFRESH_NOTIFICATION,
        });
      }
    }
  }

  private async processPendingInput(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<void> {
    if (!session.pendingInput) {
      return;
    }

    const pendingInput = session.pendingInput;
    const rawText = context.text.trim();
    if (rawText.toLowerCase() === 'отмена') {
      session.pendingInput = null;

      if (pendingInput.kind === 'channel_suggestion') {
        const view = this.renderChannelSuggestionCancelledView();
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'channel_section' && session.channelSection) {
        const view = await this.renderChannelSectionScreen(
          context,
          session,
          session.channelSection,
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'section' && session.section) {
        const view = await this.renderSectionCardScreen(context, session, session.section);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'broadcast') {
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'giveaway') {
        const view = await this.renderGiveawayScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'domains') {
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'rules') {
        const view = await this.renderRulesScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'manual_actions') {
        const view = this.renderManualActionsScreen(session.manualTargetUserId);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      if (session.screen === 'search') {
        session.searchQuery = null;
        const restored = this.restoreFromHistory(session);
        const view = restored
          ? await this.renderByCurrentScreen(context, session)
          : await this.renderPrimaryScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      const view = await this.renderPrimaryScreen(context, session);
      await this.respond(context, session, view, {
        callbackId: null,
        notification: null,
      });
      return;
    }

    switch (pendingInput.kind) {
      case 'support_request': {
        await this.captureSupportRequest(context, session, rawText);
        return;
      }

      case 'search_settings': {
        this.assertSelectedEntityType(session, 'chat');
        const query = rawText.trim();
        if (query.length < 2) {
          throw new BadRequestException('Введите минимум 2 символа для поиска.');
        }

        session.pendingInput = null;
        session.searchQuery = query;
        session.screen = 'search';
        const view = this.renderSearchResultsScreen(query);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'set_field': {
        this.assertSelectedEntityType(session, 'chat');

        const inputText = resolvePrivateControlSetFieldInputText(
          pendingInput,
          context.update,
          rawText,
        );
        const parsedValue = parsePrivateControlInputValue(
          pendingInput.type,
          pendingInput.min,
          pendingInput.max,
          inputText,
        );
        await this.updateSingleSetting(
          session.selectedChatId!,
          context.actor,
          pendingInput.key,
          parsedValue,
        );

        session.pendingInput = null;
        session.screen = 'section';
        session.section = pendingInput.section;

        const view = await this.renderSectionCardScreen(context, session, pendingInput.section);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'set_channel_field': {
        this.assertSelectedEntityType(session, 'channel');

        const parsedValue = parsePrivateControlInputValue(
          pendingInput.type,
          pendingInput.min,
          pendingInput.max,
          rawText,
        );
        await this.updateSingleChannelSetting(
          session.selectedChatId!,
          context.actor,
          pendingInput.key,
          parsedValue as ChannelSettings[keyof ChannelSettings],
        );

        session.pendingInput = null;
        session.screen = 'channel_section';
        session.channelSection = pendingInput.section;

        const view = await this.renderChannelSectionScreen(context, session, pendingInput.section);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'add_domain': {
        this.assertChatSelected(session);
        if (!rawText) {
          throw new BadRequestException('Напишите ссылку или домен.');
        }

        await this.adminService.addDomain(
          session.selectedChatId!,
          context.actor,
          {
            domain: rawText,
          },
          'private_bot',
        );

        session.pendingInput = null;
        session.screen = 'domains';
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'schedule_domain': {
        this.assertChatSelected(session);
        const removeAfterAt = parsePrivateControlRemovalDateInput(rawText);

        await this.adminService.scheduleDomainRemoval(
          session.selectedChatId!,
          context.actor,
          pendingInput.domain,
          {
            removeAfterAt,
          },
          'private_bot',
        );

        session.pendingInput = null;
        session.screen = 'domains';
        const view = await this.renderDomainsScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'rules_text': {
        const notice = await this.captureRulesContent(context, session, rawText, {
          requireText: true,
          textOnly: true,
        });
        session.pendingInput = null;
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, notice);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'rules_photo': {
        const notice = await this.captureRulesContent(context, session, rawText, {
          requireImage: true,
          imageOnly: true,
        });
        session.pendingInput = null;
        session.screen = 'rules';
        const view = await this.renderRulesScreen(context, session, notice);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'channel_suggestion': {
        const imageSourceAttachments = extractPrivateImageSourceAttachments(context.update);
        const videoSourceAttachment = extractPrivateFirstVideoSourceAttachment(context.update);
        const fileAttachment = extractPrivateFirstFileAttachment(context.update);

        if (fileAttachment && imageSourceAttachments.length === 0 && !videoSourceAttachment) {
          throw new BadRequestException(
            'Сейчас через предложку можно отправить текст, фото, видео или подпись к медиа. Произвольные файлы не поддерживаются.',
          );
        }

        if (!rawText && imageSourceAttachments.length === 0 && !videoSourceAttachment) {
          throw new BadRequestException('Пришлите текст поста, фото, видео или подпись к медиа.');
        }

        const previousDraft = session.suggestionDraft;
        const previousImages = previousDraft?.images ?? [];
        const previousVideo = previousDraft?.video ?? null;
        let nextImages = previousImages;
        let nextVideo = previousVideo;
        let mediaBotId = previousDraft?.mediaBotId ?? null;
        const currentMediaBotId = this.resolvePrivateDeliveryBotId(context, session) ?? null;
        assertPrivateSuggestionMediaBot(previousDraft, currentMediaBotId);
        assertPrivateSuggestionMediaCaptureBot(
          Boolean(imageSourceAttachments.length || videoSourceAttachment),
          currentMediaBotId,
        );

        if (imageSourceAttachments.length > 0 && videoSourceAttachment) {
          throw new BadRequestException(
            'В одну предложку можно добавить либо фото, либо одно видео.',
          );
        }

        if (videoSourceAttachment) {
          mediaBotId = currentMediaBotId;
          nextVideo = await buildPrivateSuggestionMediaDraftFromVideo(
            videoSourceAttachment,
            this.buildPrivateControlMediaUploader(context, session),
            'channel-suggestion',
          );
          nextImages = [];
        } else if (imageSourceAttachments.length > 0) {
          const baseImages = previousVideo ? [] : previousImages;
          mediaBotId = currentMediaBotId;
          if (
            baseImages.length + imageSourceAttachments.length >
            MAX_CHANNEL_DIALOG_SUGGEST_IMAGES
          ) {
            throw new BadRequestException(
              `В одной предложке можно отправить до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} фото.`,
            );
          }

          nextImages = [
            ...baseImages,
            ...(await buildPrivateSuggestionImageDraftsFromImages(
              imageSourceAttachments,
              this.buildPrivateControlMediaUploader(context, session),
              'channel-suggestion',
            )),
          ];
          nextVideo = null;
        }

        const nextTextPayload = rawText
          ? extractIncomingSuggestionTextPayload(context.update, rawText)
          : {
              text: previousDraft?.text ?? '',
              textFormat: previousDraft?.textFormat ?? 'plain',
              textMarkup: previousDraft?.textMarkup ?? [],
            };

        session.suggestionDraft = {
          chatId: pendingInput.chatId,
          token: pendingInput.token,
          text: nextTextPayload.text,
          textFormat: nextTextPayload.textFormat,
          textMarkup: nextTextPayload.textMarkup,
          images: nextImages,
          video: nextVideo,
          mediaBotId,
          imageBase64:
            imageSourceAttachments.length > 0 || videoSourceAttachment
              ? ''
              : (previousDraft?.imageBase64 ?? ''),
          imageMimeType:
            imageSourceAttachments.length > 0 || videoSourceAttachment
              ? ''
              : (previousDraft?.imageMimeType ?? ''),
          imageFileName:
            imageSourceAttachments.length > 0 || videoSourceAttachment
              ? ''
              : (previousDraft?.imageFileName ?? ''),
          sourceMessageId:
            context.update.message?.messageId ?? previousDraft?.sourceMessageId ?? null,
          previewMessageId: previousDraft?.previewMessageId ?? null,
        };
        await this.sendChannelSuggestionDraftPreview(context, session);
        return;
      }

      case 'broadcast_content': {
        await this.captureBroadcastContent(context, session, rawText);
        const view = await this.renderBroadcastScreen(context, session, 'Контент сохранён.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_content': {
        const notice = await this.captureGiveawayContent(context, session, rawText);
        const view = await this.renderGiveawayContentFollowUp(context, session, notice);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_text': {
        const textPayload = extractIncomingFormattedTextPayload(context.update, rawText);
        session.broadcastDraft.text = textPayload.text;
        session.broadcastDraft.textFormat =
          textPayload.textFormat === 'markdown' || this.shouldUseMarkdown(textPayload.text)
            ? 'markdown'
            : 'plain';
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_button_url': {
        session.broadcastDraft.buttonUrl = rawText === '-' ? '' : rawText;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_button_text': {
        session.broadcastDraft.buttonText = rawText === '-' ? '' : rawText;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_send_at': {
        session.broadcastDraft.sendAt = parsePrivateControlBroadcastSendAt(
          rawText,
          session.broadcastDraft.scheduleTimezone,
        );
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_cycle_every_hours': {
        const parsedHours = parsePrivateControlIntegerInput(rawText, 1, 14 * 24);
        session.broadcastDraft.cycleEveryHours = parsedHours;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_cycle_count': {
        const parsedCount = parsePrivateControlIntegerInput(rawText, 1, 100);
        session.broadcastDraft.cycleCount = parsedCount;
        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(context, session);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'broadcast_photo': {
        const imageSourceAttachment = extractPrivateFirstImageSourceAttachment(context.update);
        const videoSourceAttachment = extractPrivateFirstVideoSourceAttachment(context.update);
        if (imageSourceAttachment && videoSourceAttachment) {
          throw new BadRequestException(
            'В один автопостинг можно добавить либо фото, либо одно видео.',
          );
        }
        if (!imageSourceAttachment && !videoSourceAttachment) {
          throw new BadRequestException(
            'Отправьте фото, PNG/WebP/JPG файлом или видео отдельным сообщением.',
          );
        }

        if (videoSourceAttachment) {
          const video = await buildPrivateSuggestionMediaDraftFromVideo(
            videoSourceAttachment,
            this.buildPrivateControlMediaUploader(context, session),
            'private-broadcast',
          );
          session.broadcastDraft.imageEnabled = false;
          session.broadcastDraft.imageBase64 = '';
          session.broadcastDraft.imageMimeType = '';
          session.broadcastDraft.imageFileName = '';
          session.broadcastDraft.mediaType = 'video';
          session.broadcastDraft.mediaPayload = video.payload;
          session.broadcastDraft.mediaMimeType = video.mimeType;
          session.broadcastDraft.mediaFileName = video.fileName;
        } else if (imageSourceAttachment) {
          const downloaded = await downloadPrivateImageSourceAttachment(imageSourceAttachment);
          session.broadcastDraft.imageEnabled = true;
          session.broadcastDraft.imageBase64 = downloaded.base64;
          session.broadcastDraft.imageMimeType = downloaded.mimeType;
          session.broadcastDraft.imageFileName = downloaded.fileName;
          session.broadcastDraft.mediaType = null;
          session.broadcastDraft.mediaPayload = null;
          session.broadcastDraft.mediaMimeType = '';
          session.broadcastDraft.mediaFileName = '';
        }

        session.pendingInput = null;
        session.screen = 'broadcast';
        const view = await this.renderBroadcastScreen(
          context,
          session,
          videoSourceAttachment ? 'Видео добавлено в черновик.' : 'Фото добавлено в черновик.',
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_title': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.title = rawText;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Название обновлено.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_description': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.description = rawText === '-' ? '' : rawText;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(
          context,
          session,
          'Текст публикации обновлён.',
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_start_at': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const startsAt =
          rawText === '-' ? null : parsePrivateControlDateInput(rawText).toISOString();
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.startsAt = startsAt;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(
          context,
          session,
          startsAt ? 'Старт обновлён.' : 'Старт убран.',
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_end_at': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const endsAt = parsePrivateControlDateInput(rawText).toISOString();
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.endsAt = endsAt;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Финиш обновлён.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_claim_hours': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const claimHours = parsePrivateControlIntegerInput(rawText, 1, 336);
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.claimHours = claimHours;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(
          context,
          session,
          'Срок подтверждения обновлён.',
        );
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_photo': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const imageSourceAttachment = extractPrivateFirstImageSourceAttachment(context.update);
        if (!imageSourceAttachment) {
          throw new BadRequestException(
            'Отправьте фото или PNG/WebP/JPG файлом отдельным сообщением.',
          );
        }

        const downloaded = await downloadPrivateImageSourceAttachment(
          imageSourceAttachment,
          'private-giveaway',
        );
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            nextDraft.imageEnabled = true;
            nextDraft.imageBase64 = downloaded.base64;
            nextDraft.imageMimeType = downloaded.mimeType;
            nextDraft.imageFileName = downloaded.fileName;
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Фото обновлено.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'giveaway_prize': {
        this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');
        const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
        const saved = await this.updateManagedGiveawayDraftForSession(
          session.selectedChatId,
          context.actor,
          session.selectedEntityType,
          draft.id,
          (nextDraft) => {
            if (pendingInput.index < 0 || pendingInput.index > nextDraft.prizes.length) {
              throw new BadRequestException('Призовое место не найдено.');
            }

            if (pendingInput.index === nextDraft.prizes.length) {
              nextDraft.prizes = [
                ...nextDraft.prizes,
                {
                  position: nextDraft.prizes.length + 1,
                  title: rawText,
                },
              ];
              return;
            }

            nextDraft.prizes = nextDraft.prizes.map((prize, index) =>
              index === pendingInput.index ? { ...prize, title: rawText } : prize,
            );
          },
        );
        session.managedGiveawayId = saved.id;
        session.pendingInput = null;
        session.screen = 'giveaway';
        const view = await this.renderGiveawayScreen(context, session, 'Приз обновлён.');
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }

      case 'manual_mute_duration': {
        this.assertChatSelected(session);
        const muteDurationHours = parsePrivateControlIntegerInput(rawText, 1, 336);
        const result = await this.manualModerationService.applyManualModerationAction(
          session.selectedChatId!,
          pendingInput.targetUserId,
          context.actor,
          {
            action: 'MUTE',
            muteDurationHours,
          },
          'private_bot',
        );

        session.pendingInput = null;
        session.screen = 'manual_actions';
        session.manualTargetUserId = pendingInput.targetUserId;
        const view = this.renderManualActionsScreen(session.manualTargetUserId, result.message);
        await this.respond(context, session, view, {
          callbackId: null,
          notification: null,
        });
        return;
      }
    }
  }

  private async updateSingleSetting(
    chatId: string,
    actor: AuthUser,
    key: keyof ChatSettings,
    value: ChatSettings[keyof ChatSettings],
  ): Promise<void> {
    const current = await this.adminService.getSettings(chatId, actor);
    const nextSettingsBase: ChatSettings = {
      ...current,
      [key]: value,
    };
    const nextSettings = this.isDuplicateFlowSettingKey(key)
      ? normalizePrivateDuplicateFlowSettings(nextSettingsBase)
      : nextSettingsBase;

    await this.adminService.updateSettings(chatId, actor, nextSettings, 'private_bot');
  }

  private isDuplicateFlowSettingKey(key: keyof ChatSettings): boolean {
    return isPrivateDuplicateFlowSettingKey(key);
  }

  private async updateSingleChannelSetting(
    chatId: string,
    actor: AuthUser,
    key: keyof ChannelSettings,
    value: ChannelSettings[keyof ChannelSettings],
  ): Promise<void> {
    const current = await this.adminService.getChannelSettings(chatId, actor);
    const nextSettings: ChannelSettings = {
      ...current,
      [key]: value,
    };

    await this.adminService.updateChannelSettings(chatId, actor, nextSettings, 'private_bot');
  }

  private async captureRulesContent(
    context: PrivateContext,
    session: PrivateSession,
    rawText: string,
    options: {
      requireText?: boolean;
      requireImage?: boolean;
      textOnly?: boolean;
      imageOnly?: boolean;
    } = {},
  ): Promise<string> {
    this.assertSelectedEntityType(session, 'chat');

    const textPayload = extractIncomingFormattedTextPayload(context.update, rawText);
    const sourceText = extractIncomingSuggestionTextPayload(context.update, rawText).text;
    const formattedTextFits = textPayload.text.length <= MAX_CHAT_RULES_TEXT_LENGTH;
    const formattedText = formattedTextFits ? textPayload.text : sourceText;
    const formattedTextFormat = formattedTextFits ? textPayload.textFormat : 'plain';
    const normalizedText = formattedText.trim();
    const imageSourceAttachment = extractPrivateFirstImageSourceAttachment(context.update);
    const fileAttachment = extractPrivateFirstFileAttachment(context.update);
    const hasVideoAttachment = hasPrivateVideoAttachment(context.update);

    if (hasVideoAttachment) {
      throw new BadRequestException(
        'Видео в правилах не поддерживается. Отправьте текст или изображение.',
      );
    }

    if (fileAttachment && !imageSourceAttachment) {
      throw new BadRequestException('Поддерживаются только фото или PNG/WebP/JPG файлом.');
    }

    if (options.textOnly && imageSourceAttachment) {
      throw new BadRequestException('Для текста правил отправьте только текст без вложений.');
    }

    if (options.imageOnly && normalizedText) {
      throw new BadRequestException('Для фото правил отправьте только изображение без текста.');
    }

    if (!normalizedText && !imageSourceAttachment) {
      throw new BadRequestException('Отправьте текст, фото или PNG/WebP/JPG файлом.');
    }

    if (options.requireText && !normalizedText) {
      throw new BadRequestException('Отправьте текст правил следующим сообщением.');
    }

    if (options.requireImage && !imageSourceAttachment) {
      if (hasVideoAttachment) {
        throw new BadRequestException('Нужно изображение, не видео.');
      }
      if (fileAttachment) {
        throw new BadRequestException('Нужен PNG/WebP/JPG файлом или обычное фото.');
      }
      throw new BadRequestException('Отправьте фото или PNG/WebP/JPG файлом.');
    }

    const currentRules = await this.adminService.getRules(session.selectedChatId!, context.actor);
    const requiresRepublish = Boolean(currentRules.publishedMessageId || currentRules.publishedUrl);
    let imageBase64 = currentRules.imageBase64;
    let imageMimeType = currentRules.imageMimeType;
    let imageFileName = currentRules.imageFileName;

    if (imageSourceAttachment) {
      const downloaded = await downloadPrivateImageSourceAttachment(
        imageSourceAttachment,
        'private-rules',
      );
      imageBase64 = downloaded.base64;
      imageMimeType = downloaded.mimeType;
      imageFileName = downloaded.fileName;
    }

    const nextText = normalizedText ? formattedText : currentRules.text;

    await this.adminSettingsService.updateRules(
      session.selectedChatId!,
      context.actor,
      buildPrivateChatRulesDraft(currentRules, {
        text: nextText,
        textFormat: normalizedText ? formattedTextFormat : currentRules.textFormat,
        imageBase64,
        imageMimeType,
        imageFileName,
        autoTextEnabled: normalizedText ? false : currentRules.autoTextEnabled,
      }),
      'private_bot',
    );

    session.pendingInput = null;
    session.screen = 'rules';

    const republishHint = requiresRepublish ? ' Переопубликуйте правила здесь или в mini app.' : '';
    if (normalizedText && imageSourceAttachment) {
      return `Текст и фото правил обновлены.${republishHint}`;
    }
    if (imageSourceAttachment) {
      return `Фото правил обновлено.${republishHint}`;
    }
    return `Текст правил обновлён.${republishHint}`;
  }

  private async captureBroadcastContent(
    context: PrivateContext,
    session: PrivateSession,
    rawText: string,
  ): Promise<void> {
    const textPayload = extractIncomingFormattedTextPayload(context.update, rawText);
    const normalizedText = textPayload.text.trim();
    const imageSourceAttachment = extractPrivateFirstImageSourceAttachment(context.update);
    const videoSourceAttachment = extractPrivateFirstVideoSourceAttachment(context.update);

    if (imageSourceAttachment && videoSourceAttachment) {
      throw new BadRequestException(
        'В один автопостинг можно добавить либо фото, либо одно видео.',
      );
    }

    if (!normalizedText && !imageSourceAttachment && !videoSourceAttachment) {
      throw new BadRequestException('Отправьте текст, изображение или видео отдельным сообщением.');
    }

    if (normalizedText) {
      session.broadcastDraft.text = textPayload.text;
      session.broadcastDraft.textFormat =
        textPayload.textFormat === 'markdown' || this.shouldUseMarkdown(textPayload.text)
          ? 'markdown'
          : 'plain';
    }

    if (imageSourceAttachment) {
      const downloaded = await downloadPrivateImageSourceAttachment(imageSourceAttachment);
      session.broadcastDraft.imageEnabled = true;
      session.broadcastDraft.imageBase64 = downloaded.base64;
      session.broadcastDraft.imageMimeType = downloaded.mimeType;
      session.broadcastDraft.imageFileName = downloaded.fileName;
      session.broadcastDraft.mediaType = null;
      session.broadcastDraft.mediaPayload = null;
      session.broadcastDraft.mediaMimeType = '';
      session.broadcastDraft.mediaFileName = '';
    }

    if (videoSourceAttachment) {
      const video = await buildPrivateSuggestionMediaDraftFromVideo(
        videoSourceAttachment,
        this.buildPrivateControlMediaUploader(context, session),
        'private-broadcast',
      );
      session.broadcastDraft.imageEnabled = false;
      session.broadcastDraft.imageBase64 = '';
      session.broadcastDraft.imageMimeType = '';
      session.broadcastDraft.imageFileName = '';
      session.broadcastDraft.mediaType = 'video';
      session.broadcastDraft.mediaPayload = video.payload;
      session.broadcastDraft.mediaMimeType = video.mimeType;
      session.broadcastDraft.mediaFileName = video.fileName;
    }

    session.pendingInput = null;
    session.screen = 'broadcast';
  }

  private async captureGiveawayContent(
    context: PrivateContext,
    session: PrivateSession,
    rawText: string,
  ): Promise<string> {
    this.assertSelectedEntityType(session, session.selectedEntityType ?? 'chat');

    const formattedText = extractIncomingFormattedText(context.update, rawText);
    const normalizedText = formattedText.trim();
    const clearText = normalizedText === '-';
    const hasTextUpdate = clearText || normalizedText.length > 0;
    const imageSourceAttachment = extractPrivateFirstImageSourceAttachment(context.update);

    if (!hasTextUpdate && !imageSourceAttachment) {
      if (hasPrivateVideoAttachment(context.update)) {
        throw new BadRequestException(
          'Видео для публикации розыгрыша пока не поддерживается. Отправьте текст или изображение.',
        );
      }
      throw new BadRequestException(
        'Отправьте текст, фото или PNG/WebP/JPG файлом отдельным сообщением.',
      );
    }

    const downloaded = imageSourceAttachment
      ? await downloadPrivateImageSourceAttachment(imageSourceAttachment, 'private-giveaway')
      : null;
    const draft = await this.getManagedGiveawayDraftForSession(context.actor, session);
    const nextHasText = hasTextUpdate ? !clearText : draft.description.trim().length > 0;
    const nextHasImage = downloaded ? true : draft.imageEnabled;
    const saved = await this.updateManagedGiveawayDraftForSession(
      session.selectedChatId,
      context.actor,
      session.selectedEntityType,
      draft.id,
      (nextDraft) => {
        if (hasTextUpdate) {
          nextDraft.description = clearText ? '' : formattedText;
        }

        if (downloaded) {
          nextDraft.imageEnabled = true;
          nextDraft.imageBase64 = downloaded.base64;
          nextDraft.imageMimeType = downloaded.mimeType;
          nextDraft.imageFileName = downloaded.fileName;
        }
      },
    );

    session.managedGiveawayId = saved.id;
    session.pendingInput = nextHasText ? null : { kind: 'giveaway_content' };
    session.screen = 'giveaway';

    if (hasTextUpdate && downloaded) {
      return clearText
        ? 'Текст очищен, фото обновлено. Пришлите новый текст публикации.'
        : 'Текст и фото публикации обновлены.';
    }

    if (downloaded) {
      return nextHasText
        ? 'Фото публикации обновлено.'
        : 'Фото публикации обновлено. Теперь пришлите текст публикации.';
    }

    return clearText
      ? 'Текст очищен. Пришлите новый текст публикации.'
      : nextHasImage
        ? 'Текст публикации обновлён.'
        : 'Текст публикации обновлён. Фото можно добавить позже.';
  }

  private buildBroadcastHandoffState(
    entityType: ManagedEntityType,
    draft: PrivateBroadcastDraft,
  ): BroadcastHandoffState {
    const targetState =
      entityType === 'channel'
        ? resolvePrivateBroadcastDraftTargetState({
            targetMode: 'current',
            targetChatIds: draft.targetChatIds,
          })
        : resolvePrivateBroadcastDraftTargetState({
            targetMode: draft.targetMode,
            targetChatIds: draft.targetChatIds,
            applyToAllChats: draft.applyToAllChats,
          });
    return broadcastHandoffStateSchema.parse({
      targetMode: targetState.targetMode,
      targetChatIds: targetState.targetChatIds,
      applyToAllChats: targetState.applyToAllChats,
      buttons: draft.buttons.map((button) => ({ ...button })),
      buttonEnabled: draft.buttonEnabled,
      buttonUrl: draft.buttonUrl,
      buttonText: draft.buttonText,
      scheduleMode: draft.scheduleMode,
      scheduleTimezone: draft.scheduleTimezone,
      scheduledSlots: [...draft.scheduledSlots],
      sendAt: draft.sendAt,
      cycleEnabled: draft.cycleEnabled,
      cycleEveryHours: draft.cycleEveryHours,
      cycleCount: draft.cycleCount,
      hasContent: Boolean(draft.text.trim() || draft.imageEnabled || draft.mediaPayload),
    });
  }

  private async sendBroadcastDraft(params: {
    selectedChatId: string;
    selectedEntityType: ManagedEntityType;
    actor: AuthUser;
    draft: PrivateBroadcastDraft;
  }): Promise<SendBroadcastResult> {
    const targetState = resolvePrivateBroadcastDraftTargetState({
      targetMode: params.selectedEntityType === 'channel' ? 'current' : params.draft.targetMode,
      targetChatIds: params.draft.targetChatIds,
      applyToAllChats:
        params.selectedEntityType === 'channel' ? false : params.draft.applyToAllChats,
      fallbackChatId: params.selectedChatId,
    });
    const payload: PrivateBroadcastDraft = {
      ...params.draft,
      targetMode: targetState.targetMode,
      targetChatIds: targetState.targetChatIds,
      applyToAllChats: targetState.applyToAllChats,
    };

    const broadcaster = publicationWriteFreeze.requireService(this.managedBroadcastService);

    return params.selectedEntityType === 'channel'
      ? broadcaster.sendChannelBroadcast(
          params.selectedChatId,
          params.actor,
          payload,
          'private_bot',
        )
      : broadcaster.sendBroadcast(params.selectedChatId, params.actor, payload, 'private_bot');
  }

  private async finishConfirmedBroadcastPublish(params: {
    privateChatId: string;
    privateBotId?: string;
    actor: AuthUser;
    selectedChatId: string;
    selectedEntityType: ManagedEntityType;
    broadcastDraft: PrivateBroadcastDraft;
    publishClaim: {
      key: string;
      fingerprint: string;
    };
    diagnostics?: {
      callbackAction?: string | null;
      callbackArgs?: string[];
      callbackPayload?: string | null;
      screen?: string | null;
      pendingInput?: string | null;
      pendingMassAction?: string | null;
    };
  }): Promise<void> {
    let rememberPublish = false;

    try {
      const result = await this.sendBroadcastDraft({
        selectedChatId: params.selectedChatId,
        selectedEntityType: params.selectedEntityType,
        actor: params.actor,
        draft: params.broadcastDraft,
      });
      rememberPublish = true;
      await this.sendImmediate(
        params.privateChatId,
        this.buildBroadcastFollowUpMessage(result),
        undefined,
        params.privateBotId,
      );
    } catch (error: unknown) {
      const badRequestDetails = extractPrivateControlUserErrorDetails(error);
      const userMessage = publicationWriteFreeze.resolveWriteErrorMessage(error, badRequestDetails);
      const badRequestResponse = error instanceof BadRequestException ? error.getResponse() : null;
      this.logger.warn(
        {
          chatId: params.privateChatId,
          targetChatId: params.selectedChatId,
          entityType: params.selectedEntityType,
          userId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
          badRequestDetails,
          ...(badRequestResponse ? { badRequestResponse } : {}),
          callbackAction: params.diagnostics?.callbackAction ?? null,
          callbackArgs: params.diagnostics?.callbackArgs ?? [],
          callbackPayload: params.diagnostics?.callbackPayload ?? null,
          selectedChatId: params.selectedChatId,
          selectedEntityType: params.selectedEntityType,
          screen: params.diagnostics?.screen ?? null,
          pendingInput: params.diagnostics?.pendingInput ?? null,
          pendingMassAction: params.diagnostics?.pendingMassAction ?? null,
        },
        'Async private broadcast publish failed after confirmation',
      );

      try {
        await this.sendImmediate(params.privateChatId, userMessage, undefined, params.privateBotId);
      } catch (sendError: unknown) {
        this.logger.warn(
          {
            chatId: params.privateChatId,
            userId: params.actor.userId,
            err: sendError instanceof Error ? sendError.message : String(sendError),
          },
          'Failed to deliver async private broadcast error notice',
        );
      }
    } finally {
      this.releaseBroadcastPublish(
        params.publishClaim.key,
        params.publishClaim.fingerprint,
        rememberPublish,
      );
    }
  }

  private buildBroadcastFollowUpMessage(result: SendBroadcastResult): string {
    if (result.failedChats > 0) {
      return `⚠️ ${this.buildBroadcastCompletionNotice(result)}`;
    }

    return this.buildBroadcastSuccessMessage(result);
  }

  private claimBroadcastPublish(
    session: PrivateSession,
  ): { key: string; fingerprint: string } | 'active' | 'recent' {
    const key = this.buildBroadcastPublishLockKey(session);
    const fingerprint = this.buildBroadcastPublishFingerprint(session);
    const now = Date.now();
    const recent = this.recentBroadcastPublishes.get(key);

    if (recent && recent.expiresAt <= now) {
      this.recentBroadcastPublishes.delete(key);
    } else if (recent && recent.fingerprint === fingerprint) {
      return 'recent';
    }

    if (this.activeBroadcastPublishes.has(key)) {
      return 'active';
    }

    this.activeBroadcastPublishes.add(key);
    return { key, fingerprint };
  }

  private releaseBroadcastPublish(key: string, fingerprint: string, remember: boolean): void {
    this.activeBroadcastPublishes.delete(key);

    if (!remember) {
      return;
    }

    this.recentBroadcastPublishes.set(key, {
      fingerprint,
      expiresAt: Date.now() + BROADCAST_PUBLISH_DEDUP_WINDOW_MS,
    });
  }

  private buildBroadcastPublishLockKey(session: PrivateSession): string {
    return `${session.selectedEntityType ?? 'chat'}:${session.selectedChatId ?? ''}`;
  }

  private buildBroadcastPublishFingerprint(session: PrivateSession): string {
    const draft = session.broadcastDraft;

    return JSON.stringify({
      chatId: session.selectedChatId ?? '',
      entityType: session.selectedEntityType ?? 'chat',
      text: draft.text,
      textFormat: draft.textFormat,
      targetMode: draft.targetMode,
      targetChatIds: [...draft.targetChatIds].sort((left, right) => left.localeCompare(right)),
      applyToAllChats: draft.applyToAllChats,
      buttons: draft.buttons,
      buttonEnabled: draft.buttonEnabled,
      buttonUrl: draft.buttonUrl.trim(),
      buttonText: draft.buttonText,
      imageEnabled: draft.imageEnabled,
      imageBase64: draft.imageBase64,
      imageMimeType: draft.imageMimeType,
      imageFileName: draft.imageFileName,
      mediaType: draft.mediaType,
      mediaPayload: draft.mediaPayload,
      mediaMimeType: draft.mediaMimeType,
      mediaFileName: draft.mediaFileName,
      scheduleMode: draft.scheduleMode,
      scheduleTimezone: draft.scheduleTimezone,
      scheduledSlots: [...draft.scheduledSlots].sort((left, right) => left.localeCompare(right)),
      sendAt: draft.sendAt,
      cycleEnabled: draft.cycleEnabled,
      cycleEveryHours: draft.cycleEveryHours,
      cycleCount: draft.cycleCount,
    });
  }

  private createDefaultGiveawayDraft(): UpdateManagedGiveawayRequest {
    return {
      title: 'Новый розыгрыш',
      description: '',
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      startsAt: null,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      claimHours: 24,
      requiredChannelIds: [],
      prizes: [
        {
          position: 1,
          title: 'Приз 1',
        },
      ],
    };
  }

  private toGiveawayUpdatePayload(giveaway: ManagedGiveawayDetails): UpdateManagedGiveawayRequest {
    return {
      title: giveaway.title,
      description: giveaway.description,
      imageEnabled: giveaway.imageEnabled,
      imageBase64: giveaway.imageBase64,
      imageMimeType: giveaway.imageMimeType,
      imageFileName: giveaway.imageFileName,
      startsAt: giveaway.startsAt,
      endsAt: giveaway.endsAt,
      claimHours: giveaway.claimHours,
      requiredChannelIds: giveaway.requiredChannelIds,
      prizes: giveaway.prizes.map((prize) => ({
        position: prize.position,
        title: prize.title,
        displayTitle: prize.displayTitle,
      })),
    };
  }

  private async createManagedGiveawayDraftForSession(
    chatId: string,
    actor: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedGiveawayDetails> {
    return this.managedGiveawayService.createManagedGiveaway(
      chatId,
      actor,
      this.createDefaultGiveawayDraft(),
      entityType,
      'private_bot',
    );
  }

  private async updateManagedGiveawayDraftForSession(
    chatId: string,
    actor: AuthUser,
    entityType: ManagedEntityType,
    giveawayId: string,
    updater: (draft: UpdateManagedGiveawayRequest) => void,
  ): Promise<ManagedGiveawayDetails> {
    const giveaway = await this.managedGiveawayService.getManagedGiveaway(
      chatId,
      giveawayId,
      actor,
      entityType,
    );
    if (giveaway.status !== 'DRAFT') {
      throw new BadRequestException('Изменять можно только черновик розыгрыша.');
    }

    const nextDraft = this.toGiveawayUpdatePayload(giveaway);
    updater(nextDraft);

    return this.managedGiveawayService.updateManagedGiveaway(
      chatId,
      giveawayId,
      actor,
      nextDraft,
      entityType,
      'private_bot',
    );
  }

  private async getManagedGiveawayDraftForSession(
    actor: AuthUser,
    session: PrivateSession,
  ): Promise<ManagedGiveawayDetails> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      throw new BadRequestException('Сначала выберите чат или канал.');
    }

    const giveaway = await this.getManagedGiveawayForSession(actor, session);
    if (!giveaway || giveaway.status !== 'DRAFT') {
      throw new BadRequestException('Черновик розыгрыша не найден.');
    }

    return giveaway;
  }

  private async renderChatSelection(
    _context: PrivateContext,
    _session: PrivateSession,
    _options: { refresh?: boolean } = {},
  ): Promise<PrivateView> {
    return this.renderLauncherHomeView('Выбирайте чат и канал в приложении.');
  }

  private async renderPrimaryScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    return this.renderHomeScreen(context, session);
  }

  private async renderByCurrentScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    // FLAG: Back navigation can restore a retired draft independently of its blocked callbacks.
    if (this.hasRetiredPublishingSession(session)) {
      return this.renderPublikHandoff(session);
    }
    if (session.screen === 'chat_select') {
      return this.renderHomeScreen(context, session);
    }
    if (session.screen === 'home') {
      return this.renderHomeScreen(context, session);
    }
    if (!session.selectedChatId) {
      return this.renderHomeScreen(context, session);
    }
    if (
      session.screen === 'settings_hub' ||
      session.screen === 'section' ||
      session.screen === 'channel_section' ||
      session.screen === 'domains' ||
      session.screen === 'search'
    ) {
      this.resetSessionToPrimaryScreen(session);
      return this.renderEntitySettingsMovedToMiniappScreen(context, session);
    }
    if (session.screen === 'rules') {
      return this.renderRulesScreen(context, session);
    }
    if (session.screen === 'giveaway') {
      this.resetSessionToPrimaryScreen(session);
      return this.renderEntityGiveawayMovedToMiniappScreen(context, session);
    }
    if (
      session.screen === 'events' ||
      session.screen === 'logs' ||
      session.screen === 'manual_users' ||
      session.screen === 'manual_actions'
    ) {
      this.resetSessionToPrimaryScreen(session);
      return this.renderEntityActivityMovedToMiniappScreen(context, session);
    }

    return this.renderPrimaryScreen(context, session);
  }

  private async renderGiveawayContentPrompt(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return this.renderInputPrompt({ kind: 'giveaway_content' });
    }

    const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
    const giveawaySettingsMiniappUrl = this.buildGiveawaySettingsMiniappUrl(
      session.selectedChatId,
      session.selectedEntityType,
    );
    const giveawaySettingsMiniappRoute = this.buildGiveawaySettingsMiniappRoute(
      session.selectedChatId,
      session.selectedEntityType,
    );
    const hasSavedContent = Boolean(giveaway?.description.trim() || giveaway?.imageEnabled);
    const previewText = hasSavedContent && giveaway ? this.buildGiveawayPreviewText(giveaway) : '';
    const usesMarkdown = this.shouldUseMarkdown(previewText);
    const entityLead = await this.buildSelectedEntityLeadLine(context.actor, session, usesMarkdown);
    const imagePayload = giveaway
      ? await this.buildContentPreviewImagePayload(
          giveaway,
          'private-giveaway-preview',
          this.resolvePrivateDeliveryBotId(context, session),
        )
      : undefined;
    const rows: MaxMessageButton[][] = [];

    if (hasSavedContent) {
      rows.push([this.callbackButton('Опубликовать', this.cb('giveaway_publish'), 'positive')]);
    }

    rows.push([
      this.buildMiniappLaunchButton(
        'В приложение',
        giveawaySettingsMiniappRoute,
        giveawaySettingsMiniappUrl,
      ),
    ]);

    const textPayload =
      previewText.length > 0 && usesMarkdown
        ? this.buildMarkdownPreviewText({
            entityLead,
            contentText: previewText,
            promptText: 'Пришлите новый текст или фото.',
            notice,
          })
        : this.buildPlainPreviewText({
            entityLead,
            contentText: previewText.length > 0 ? previewText : null,
            promptText:
              previewText.length > 0
                ? 'Пришлите новый текст или фото.'
                : 'Пришлите текст или фото.',
            notice,
          });

    return {
      text: textPayload.text,
      options: {
        buttons: rows,
        ...(imagePayload ? { imagePayload } : {}),
        ...(textPayload.textFormat ? { textFormat: textPayload.textFormat } : {}),
      },
    };
  }

  private async renderGiveawayContentFollowUp(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (session.pendingInput?.kind === 'giveaway_content') {
      return this.renderGiveawayContentPrompt(context, session, notice);
    }

    return this.renderGiveawayDraftPreview(context, session, notice);
  }

  private async renderGiveawayDraftPreview(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
    if (!giveaway || giveaway.status !== 'DRAFT') {
      return this.renderGiveawayScreen(context, session);
    }

    if (!giveaway.description.trim()) {
      return this.renderGiveawayContentPrompt(context, session, notice);
    }

    const giveawaySettingsMiniappUrl = this.buildGiveawaySettingsMiniappUrl(
      session.selectedChatId!,
      session.selectedEntityType!,
    );
    const giveawaySettingsMiniappRoute = this.buildGiveawaySettingsMiniappRoute(
      session.selectedChatId!,
      session.selectedEntityType!,
    );
    const imagePayload = await this.buildContentPreviewImagePayload(
      giveaway,
      'private-giveaway-preview',
      this.resolvePrivateDeliveryBotId(context, session),
    );
    const previewText = this.buildGiveawayPreviewText(giveaway);
    const previewTextFormat = this.buildGiveawayPreviewTextFormat(previewText);
    const usesMarkdown = previewTextFormat === 'markdown';
    const entityLead = await this.buildSelectedEntityLeadLine(context.actor, session, usesMarkdown);
    const textPayload = usesMarkdown
      ? this.buildMarkdownPreviewText({
          entityLead,
          contentText: previewText,
          promptText: null,
          notice,
        })
      : this.buildPlainPreviewText({
          entityLead,
          contentText: previewText,
          promptText: null,
          notice,
        });

    return {
      text: textPayload.text,
      options: {
        buttons: this.buildGiveawayDraftActionRows(
          giveawaySettingsMiniappRoute,
          giveawaySettingsMiniappUrl,
        ),
        ...(imagePayload ? { imagePayload } : {}),
        ...(textPayload.textFormat ? { textFormat: textPayload.textFormat } : {}),
      },
    };
  }

  private async renderChannelHomeScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderHomeScreen(context, session);
    }

    return this.renderEntitySettingsMovedToMiniappScreen(context, session);
  }

  private async renderChannelSectionScreen(
    context: PrivateContext,
    session: PrivateSession,
    section: ChannelSectionKey,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const settings = await this.adminService.getChannelSettings(
      session.selectedChatId,
      context.actor,
    );
    const lines: string[] = [
      privateMarkdownTitle(CHANNEL_SECTION_LABELS[section]),
      '',
      ...settingsRenderer.buildChannelSectionSummary(section, settings),
    ];

    const rows = settingsRenderer.buildChannelSectionRows(section, settings);

    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderHomeScreen(
    _context: PrivateContext,
    _session: PrivateSession,
  ): Promise<PrivateView> {
    return this.renderLauncherHomeView();
  }

  private async renderSettingsHubScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const chatTitle = await this.resolveManagedEntityTitle(
      context.actor,
      'chat',
      session.selectedChatId,
    );
    const lines: string[] = [
      privateMarkdownTitle('Разделы настроек'),
      '',
      `Чат: ${escapePrivateMarkdown(chatTitle)}`,
      'Выберите раздел.',
    ];

    const rows: MaxMessageButton[][] = SECTION_ORDER.map((section) => [
      this.callbackButton(SECTION_LABELS[section], this.cb('open_section', section)),
    ]);

    rows.push([
      this.callbackButton('Поиск', this.cb('open_search')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderSectionCardScreen(
    context: PrivateContext,
    session: PrivateSession,
    section: PrivateSectionKey,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const settings = await this.adminService.getSettings(session.selectedChatId, context.actor);
    const lines: string[] = [
      privateMarkdownTitle(SECTION_LABELS[section]),
      '',
      `Режим: ${session.sectionView === 'basic' ? 'Основное' : 'Ещё параметры'}`,
      '',
      ...settingsRenderer.buildSectionSummaryLines(section, settings, session.sectionView),
    ];

    const rows = settingsRenderer.buildSectionActionRows(section, settings, session.sectionView);
    if (section === 'limits') {
      const route = this.buildEntitySettingsMiniappRoute(
        session.selectedChatId,
        'chat',
        'stopWords',
      );
      rows.push([
        this.buildMiniappLaunchButton(
          'Стоп-слова',
          route,
          this.appBaseUrl ? this.appBaseUrl + '/app' + route : null,
        ),
      ]);
    }

    if (section === 'links' && session.sectionView === 'advanced') {
      rows.push([this.callbackButton('Разрешённые домены', this.cb('open_domains'))]);
    }

    const hasAdvanced = SECTION_CARD_FIELDS[section].advanced.length > 0;
    if (hasAdvanced) {
      if (session.sectionView === 'basic') {
        rows.push([
          this.callbackButton('⚙️ Ещё параметры', this.cb('section_view', section, 'advanced')),
        ]);
      } else {
        rows.push([this.callbackButton('⬅️ Основное', this.cb('section_view', section, 'basic'))]);
      }
    }

    rows.push([
      this.callbackButton(
        'Применить раздел ко всем чатам',
        this.cb('apply_section_preview', section),
        'positive',
      ),
    ]);
    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Разделы', this.cb('open_settings_hub')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderDomainsScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const domains = await this.adminService.getDomainAllowlistDetails(
      session.selectedChatId,
      context.actor,
    );
    const pageInfo = paginatePrivateControlItems(domains, session.domainPage, PAGE_SIZE_DOMAINS);
    session.domainPage = pageInfo.page;

    const lines: string[] = ['Разрешённые ссылки и домены', ''];

    if (domains.length === 0) {
      lines.push('Список пока пуст.');
    } else {
      lines.push(`Всего правил: ${domains.length}`);
      lines.push('');
      lines.push(
        ...pageInfo.items.map((entry, index) => {
          const idx = pageInfo.start + index + 1;
          const schedule = entry.removeAfterAt
            ? `удалить: ${formatPrivateControlIsoDate(entry.removeAfterAt)}`
            : 'без автоудаления';
          return `${idx}. ${formatPrivateControlAllowlistEntryLabel(entry)} (${schedule})`;
        }),
      );
    }

    lines.push('');
    lines.push('Чтобы добавить правило, отправьте URL или домен.');
    lines.push('Чтобы задать автоудаление, введите ISO или `ДД.ММ.ГГГГ ЧЧ:ММ`.');

    const rows: MaxMessageButton[][] = [
      [this.callbackButton('Добавить домен', this.cb('domain_add_prompt'), 'positive')],
    ];

    for (const [index, entry] of pageInfo.items.entries()) {
      const globalIndex = pageInfo.start + index + 1;
      rows.push([
        this.callbackButton(
          `❌ ${compactPrivateText(formatPrivateControlAllowlistEntryLabel(entry), 20)}`,
          this.cb('domain_remove', String(globalIndex)),
        ),
        this.callbackButton(
          `🕒 ${globalIndex}`,
          this.cb('domain_schedule_prompt', String(globalIndex)),
        ),
      ]);
    }

    rows.push(this.paginationButtons(pageInfo.page, pageInfo.pages, 'domains_page'));
    if (session.uiMode === 'modern') {
      rows.push([
        this.callbackButton('⬅️ Назад', this.cb('back')),
        this.callbackButton('Главный экран', this.cb('home')),
      ]);
    } else {
      rows.push([this.callbackButton('⬅️ К разделу «Ссылки»', this.cb('open_section', 'links'))]);
    }
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderRulesScreen(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderLauncherHomeView(
        'Откройте нужный чат в приложении и запустите быстрый редактор правил ещё раз.',
      );
    }

    if (session.selectedEntityType === 'channel') {
      return this.renderEntityRulesMovedToMiniappScreen(context, session);
    }

    const [rules, chatTitle] = await Promise.all([
      this.adminService.getRules(session.selectedChatId, context.actor),
      this.resolveManagedEntityTitle(context.actor, 'chat', session.selectedChatId),
    ]);

    const hasText = rules.text.trim().length > 0;
    const hasImage = rules.imageBase64.trim().length > 0;
    const rulesSettingsMiniappUrl = this.buildRulesSettingsMiniappUrl(session.selectedChatId);
    const rulesSettingsMiniappRoute = this.buildRulesSettingsMiniappRoute(session.selectedChatId);
    const waitingHint =
      session.pendingInput?.kind === 'rules_text'
        ? 'Отправьте новый текст одним сообщением.'
        : session.pendingInput?.kind === 'rules_photo'
          ? 'Отправьте новое фото одним сообщением.'
          : null;

    const lines: string[] = [
      privateMarkdownTitle('Правила'),
      '',
      `Чат: ${escapePrivateMarkdown(chatTitle)}`,
      '',
      hasText
        ? buildPrivateRulesScreenTextPreview(rules.text, rules.textFormat)
        : '_Текст правила пока не задан._',
    ];

    if (waitingHint) {
      lines.push('', escapePrivateMarkdown(waitingHint));
    }

    if (hasImage) {
      lines.push('', 'Фото прикреплено.');
    }

    if (rules.publishedAt) {
      lines.push('', `Опубликовано: ${formatPrivateControlIsoDate(rules.publishedAt)}`);
    }

    if (notice) {
      lines.push('', `Статус: ${escapePrivateMarkdown(notice)}`);
    }

    const rows: MaxMessageButton[][] = [
      [this.callbackButton('Собрать из настроек 🤖', this.cb('rules_autofill'))],
      [this.callbackButton('✏️ Изменить текст', this.cb('rules_input_prompt', 'text'))],
      [
        this.callbackButton(
          hasImage ? '✏️ Изменить фото' : '✍️ Добавить фото',
          this.cb('rules_input_prompt', 'photo'),
        ),
      ],
    ];

    if (hasImage) {
      rows.push([this.callbackButton('🗑️ Убрать фото', this.cb('rules_clear_photo'), 'negative')]);
    }

    rows.push([this.callbackButton('🚀 Опубликовать', this.cb('rules_publish'), 'positive')]);

    if (rules.publishedMessageId || rules.publishedUrl) {
      const publicationRow: MaxMessageButton[] = [];
      if (rules.publishedUrl) {
        publicationRow.push({
          type: 'link',
          text: '📨 Открыть пост',
          url: rules.publishedUrl,
        });
      }
      publicationRow.push(
        this.callbackButton(
          '🗑️ Сбросить публикацию',
          this.cb('rules_reset_publication'),
          'negative',
        ),
      );
      rows.push(publicationRow);
    }

    rows.push(
      ...this.buildFooterButtons({
        miniappText: '📱 В приложение',
        miniappRoute: rulesSettingsMiniappRoute,
        miniappUrl: rulesSettingsMiniappUrl,
      }),
    );

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
        textFormat: 'markdown',
      },
    };
  }

  private buildRulesTextFromSettings(screen: ChatSettingsScreenResponse): string {
    const items = buildPrivateRulesTextItems(screen);
    if (items.length === 0) {
      throw new BadRequestException('Нет активных настроек, из которых можно собрать правила.');
    }

    const lines = ['Правила чата:', ''];
    const numberedItems: string[] = [];

    for (const [index, item] of items.entries()) {
      const numberedItem = `${index + 1}. ${item}`;
      const candidate = [...lines, ...numberedItems, numberedItem].join('\n');
      if (candidate.length > MAX_CHAT_RULES_TEXT_LENGTH) {
        break;
      }
      numberedItems.push(numberedItem);
    }

    if (numberedItems.length === 0) {
      throw new BadRequestException(
        'Не удалось собрать короткий текст правил из текущих настроек.',
      );
    }

    return [...lines, ...numberedItems].join('\n');
  }

  private async renderBroadcastScreen(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderLauncherHomeView(
        'Откройте нужный чат или канал в приложении и запустите быстрый пост ещё раз.',
      );
    }

    const draft = session.broadcastDraft;
    const entityType = session.selectedEntityType ?? 'chat';
    const waitingForContent = session.pendingInput?.kind === 'broadcast_content';
    const plannerUrl = this.buildBroadcastSettingsMiniappUrl(session.selectedChatId, entityType);
    const plannerRoute = this.buildBroadcastSettingsMiniappRoute(
      session.selectedChatId,
      entityType,
    );
    const hasText = draft.text.trim().length > 0;
    const hasVideo = draft.mediaType === 'video' && Boolean(draft.mediaPayload);
    const hasContent = hasText || draft.imageEnabled || hasVideo;
    const usesMarkdown = hasText && draft.textFormat === 'markdown';
    const entityLead = await this.buildSelectedEntityLeadLine(context.actor, session, usesMarkdown);
    const imagePayload = hasContent
      ? await this.buildContentPreviewImagePayload(
          {
            imageEnabled: draft.imageEnabled,
            imageBase64: draft.imageBase64,
            imageMimeType: draft.imageMimeType,
            imageFileName: draft.imageFileName,
          },
          'private-broadcast-preview',
          this.resolvePrivateDeliveryBotId(context, session),
        )
      : undefined;
    const promptText =
      waitingForContent || !hasContent
        ? 'Пришлите текст, фото или видео.'
        : 'Пришлите новый текст, фото или видео.';
    const textPayload = usesMarkdown
      ? this.buildBroadcastMarkdownPreviewText({
          entityLead,
          contentText: hasText ? draft.text : null,
          hasImage: draft.imageEnabled,
          hasVideo,
          promptText,
          notice,
        })
      : this.buildBroadcastPlainPreviewText({
          entityLead,
          contentText: hasText ? draft.text : null,
          hasImage: draft.imageEnabled,
          hasVideo,
          promptText,
          notice,
        });
    const rows: MaxMessageButton[][] = [];

    rows.push([
      this.callbackButton(
        hasContent ? '✏️ Изменить' : '✍️ Добавить',
        this.cb('broadcast_input_prompt', 'content'),
      ),
    ]);

    if (hasContent) {
      rows.push([
        this.callbackButton('🧹 Сбросить', this.cb('broadcast_clear_content'), 'negative'),
      ]);
    }

    if (hasContent && draft.imageEnabled) {
      rows.push([this.callbackButton('🗑️ Убрать', this.cb('broadcast_clear_photo'), 'negative')]);
    }

    if (hasContent && hasVideo) {
      rows.push([this.callbackButton('🗑️ Убрать', this.cb('broadcast_clear_photo'), 'negative')]);
    }

    if (hasContent) {
      rows.push([this.callbackButton('🚀 Опубликовать', this.cb('broadcast_send'), 'positive')]);
    }

    rows.push([this.buildMiniappLaunchButton('📱 В приложение', plannerRoute, plannerUrl)]);

    return {
      text: textPayload.text,
      options: {
        buttons: rows,
        ...(imagePayload ? { imagePayload } : {}),
        ...(textPayload.textFormat ? { textFormat: textPayload.textFormat } : {}),
      },
    };
  }

  private renderBroadcastLaunchingView(
    session: Pick<PrivateSession, 'selectedChatId' | 'selectedEntityType'>,
  ): PrivateView {
    const entityType = session.selectedEntityType === 'channel' ? 'channel' : 'chat';
    const entityLabel = entityType === 'channel' ? 'Канал' : 'Чат';
    const selectedChatId = session.selectedChatId?.trim() ?? '';
    const plannerUrl = selectedChatId
      ? this.buildBroadcastSettingsMiniappUrl(selectedChatId, entityType)
      : null;
    const plannerRoute = selectedChatId
      ? this.buildBroadcastSettingsMiniappRoute(selectedChatId, entityType)
      : null;
    const rows: MaxMessageButton[][] = [];

    if (selectedChatId && plannerUrl && plannerRoute) {
      rows.push([this.buildMiniappLaunchButton('📱 В приложение', plannerRoute, plannerUrl)]);
    }

    const lines = ['Автопостинг запускается.'];
    if (selectedChatId) {
      lines.push(`${entityLabel}: ${selectedChatId}`);
    }
    lines.push('Итоговый статус придёт следующим сообщением.');

    return {
      text: lines.join('\n\n'),
      options: rows.length > 0 ? { buttons: rows } : undefined,
    };
  }

  private async renderGiveawayScreen(
    context: PrivateContext,
    session: PrivateSession,
    notice: string | null = null,
  ): Promise<PrivateView> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return this.renderChatSelection(context, session);
    }

    const giveaway = await this.getManagedGiveawayForSession(context.actor, session);
    if (giveaway?.status === 'DRAFT') {
      if (session.pendingInput?.kind === 'giveaway_content' || !giveaway.description.trim()) {
        return this.renderGiveawayContentPrompt(context, session, notice);
      }

      return this.renderGiveawayDraftPreview(context, session, notice);
    }

    const entityLabel = session.selectedEntityType === 'channel' ? 'Канал' : 'Чат';
    const entityTitle = await this.resolveManagedEntityTitle(
      context.actor,
      session.selectedEntityType,
      session.selectedChatId,
    );
    const rows: MaxMessageButton[][] = [];
    const lines: string[] = [
      privateMarkdownTitle('Розыгрыш'),
      '',
      `${entityLabel}: ${escapePrivateMarkdown(entityTitle)}`,
    ];

    if (!giveaway) {
      lines.push('', 'Черновик не создан.');
      rows.push([this.callbackButton('Создать черновик', this.cb('giveaway_create'), 'positive')]);
    } else {
      lines.push(
        `Название: ${escapePrivateMarkdown(giveaway.title)}`,
        '',
        'Контент публикации:',
        giveaway.description.trim() || 'не задан',
        ...(giveaway.imageEnabled
          ? ['', 'Медиа: фото будет отправлено вместе с публикацией.']
          : []),
        '',
        `Мест: ${giveaway.prizes.length}`,
        ...(giveaway.endsAt
          ? [`Финиш: ${formatPrivateControlDateTimeLabel(giveaway.endsAt)}`]
          : []),
        ...(giveaway.status === 'ACTIVE' ||
        giveaway.status === 'SCHEDULED' ||
        giveaway.status === 'COMPLETED'
          ? [`Участники: ${giveaway.entriesCount}`, `Победители: ${giveaway.winnersCount}`]
          : []),
        'Остальные настройки редактируются в приложении.',
      );

      if (giveaway.status === 'ACTIVE' || giveaway.status === 'SCHEDULED') {
        rows.push([
          this.callbackButton('Завершить розыгрыш', this.cb('giveaway_close'), 'positive'),
        ]);
        rows.push([
          this.callbackButton('Отменить розыгрыш', this.cb('giveaway_cancel'), 'negative'),
        ]);
      }

      const winnerActionRows = giveaway.winners.flatMap((winner) => {
        const actionRow: MaxMessageButton[] = [];

        if (
          giveaway.status === 'COMPLETED' &&
          (winner.status === 'SELECTED' ||
            winner.status === 'CLAIMED' ||
            winner.status === 'EXPIRED')
        ) {
          actionRow.push(
            this.callbackButton(
              `Реролл ${winner.prizePosition}`,
              this.cb('giveaway_reroll', winner.id),
            ),
          );
        }

        if (winner.status === 'SELECTED' || winner.status === 'CLAIMED') {
          actionRow.push(
            this.callbackButton(
              `Выдано ${winner.prizePosition}`,
              this.cb('giveaway_deliver', winner.id),
              'positive',
            ),
          );
        }

        return actionRow.length > 0 ? [actionRow] : [];
      });
      rows.push(...winnerActionRows);
    }

    if (notice) {
      lines.push('', `Результат: ${escapePrivateMarkdown(notice)}`);
    }

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
        textFormat: 'markdown',
      },
    };
  }

  private buildGiveawayDraftActionRows(
    giveawaySettingsMiniappRoute: string,
    giveawaySettingsMiniappUrl: string | null,
  ): MaxMessageButton[][] {
    return [
      [this.callbackButton('Опубликовать', this.cb('giveaway_publish'), 'positive')],
      [
        this.buildMiniappLaunchButton(
          'В приложение',
          giveawaySettingsMiniappRoute,
          giveawaySettingsMiniappUrl,
        ),
      ],
    ];
  }

  private buildGiveawayPreviewText(
    giveaway: Pick<ManagedGiveawayDetails, 'description' | 'title'>,
  ): string {
    const description = giveaway.description.trim();
    if (description) {
      return description;
    }

    const title = giveaway.title.trim();
    return title || 'Розыгрыш';
  }

  private buildGiveawayPreviewTextFormat(
    previewText: string,
  ): MaxSendMessageOptions['textFormat'] | undefined {
    return this.shouldUseMarkdown(previewText) ? 'markdown' : undefined;
  }

  private buildBroadcastPlainPreviewText(payload: {
    entityLead: string | null;
    contentText: string | null;
    hasImage: boolean;
    hasVideo: boolean;
    promptText: string | null;
    notice: string | null;
  }): { text: string; textFormat?: MaxSendMessageOptions['textFormat'] } {
    const lines: string[] = ['Автопостинг'];

    if (payload.entityLead) {
      lines.push('', payload.entityLead);
    }

    if (payload.contentText || payload.hasImage || payload.hasVideo) {
      lines.push('', 'Контент:');
      lines.push(
        payload.contentText ?? (payload.hasVideo ? 'Видео без текста.' : 'Фото без текста.'),
      );
    }

    if (payload.notice) {
      lines.push('', `Статус: ${payload.notice}`);
    }

    if (payload.promptText) {
      lines.push('', `Дальше: ${payload.promptText}`);
    }

    return { text: lines.join('\n') };
  }

  private buildBroadcastMarkdownPreviewText(payload: {
    entityLead: string | null;
    contentText: string | null;
    hasImage: boolean;
    hasVideo: boolean;
    promptText: string | null;
    notice: string | null;
  }): { text: string; textFormat: MaxSendMessageOptions['textFormat'] } {
    const lines: string[] = [privateMarkdownTitle('Автопостинг')];

    if (payload.entityLead) {
      lines.push('', payload.entityLead);
    }

    if (payload.contentText || payload.hasImage || payload.hasVideo) {
      lines.push(
        '',
        privateMarkdownTitle('Контент'),
        '',
        payload.contentText ?? (payload.hasVideo ? 'Видео без текста.' : 'Фото без текста.'),
      );
    }

    if (payload.notice) {
      lines.push('', `Статус: ${escapePrivateMarkdown(payload.notice)}`);
    }

    if (payload.promptText) {
      lines.push('', `Дальше: ${escapePrivateMarkdown(payload.promptText)}`);
    }

    return {
      text: lines.join('\n'),
      textFormat: 'markdown',
    };
  }

  private buildPlainPreviewText(payload: {
    entityLead: string | null;
    contentText: string | null;
    promptText: string | null;
    notice: string | null;
  }): { text: string; textFormat?: MaxSendMessageOptions['textFormat'] } {
    const lines: string[] = [];

    if (payload.entityLead) {
      lines.push(payload.entityLead);
    }

    if (payload.contentText) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(payload.contentText);
    }

    if (payload.promptText) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(payload.promptText);
    }

    if (payload.notice) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(payload.notice);
    }

    return { text: lines.join('\n') };
  }

  private buildMarkdownPreviewText(payload: {
    entityLead: string | null;
    contentText: string | null;
    promptText: string | null;
    notice: string | null;
  }): { text: string; textFormat: MaxSendMessageOptions['textFormat'] } {
    const lines: string[] = [];

    if (payload.entityLead) {
      lines.push(payload.entityLead);
    }

    if (payload.contentText) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(payload.contentText);
    }

    if (payload.promptText) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(escapePrivateMarkdown(payload.promptText));
    }

    if (payload.notice) {
      if (lines.length > 0) {
        lines.push('');
      }
      lines.push(escapePrivateMarkdown(payload.notice));
    }

    return {
      text: lines.join('\n'),
      textFormat: 'markdown',
    };
  }

  private async buildContentPreviewImagePayload(
    content: Pick<
      ManagedGiveawayDetails,
      'imageEnabled' | 'imageBase64' | 'imageMimeType' | 'imageFileName'
    >,
    filePrefix: string,
    botId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (!content.imageEnabled || !content.imageBase64.trim()) {
      return undefined;
    }

    const mimeType = content.imageMimeType.trim() || 'image/jpeg';

    try {
      const imageBuffer = Buffer.from(content.imageBase64, 'base64');
      if (imageBuffer.length === 0) {
        return undefined;
      }

      const fileName = buildPrivateDownloadedFileName(
        filePrefix,
        content.imageFileName,
        null,
        mimeType,
      );
      return botId
        ? await this.maxClient.uploadImage(imageBuffer, fileName, mimeType, { botId })
        : await this.maxClient.uploadImage(imageBuffer, fileName, mimeType);
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to upload private preview image',
      );
      return undefined;
    }
  }

  private async getManagedGiveawayForSession(
    user: AuthUser,
    session: PrivateSession,
  ): Promise<ManagedGiveawayDetails | null> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return null;
    }

    if (session.managedGiveawayId) {
      return this.managedGiveawayService.getManagedGiveaway(
        session.selectedChatId,
        session.managedGiveawayId,
        user,
        session.selectedEntityType,
      );
    }

    return this.managedGiveawayService.getCurrentManagedGiveawayForEntity(
      session.selectedChatId,
      user,
      session.selectedEntityType,
    );
  }

  private async resolveManagedEntityTitle(
    actor: AuthUser,
    entityType: ManagedEntityType,
    entityId: string,
  ): Promise<string> {
    const entities = await this.adminService.listManagedEntities(actor, entityType);
    const selected = entities.find((entity) => entity.id === entityId);
    const normalizedTitle = selected?.title?.trim() ?? '';
    return normalizedTitle.length > 0 ? normalizedTitle : entityId;
  }

  private async buildSelectedEntityLeadLine(
    actor: AuthUser,
    session: Pick<PrivateSession, 'selectedChatId' | 'selectedEntityType'>,
    markdown: boolean,
  ): Promise<string | null> {
    if (!session.selectedChatId || !session.selectedEntityType) {
      return null;
    }

    const entityLabel = session.selectedEntityType === 'channel' ? 'Канал' : 'Чат';
    const entityTitle = await this.resolveManagedEntityTitle(
      actor,
      session.selectedEntityType,
      session.selectedChatId,
    );

    return markdown
      ? `${entityLabel}: ${escapePrivateMarkdown(entityTitle)}`
      : `${entityLabel}: ${entityTitle}`;
  }

  private buildBroadcastCompletionNotice(result: SendBroadcastResult): string {
    if (result.sentChats === 0 && result.nextSendAt) {
      return `Будет опубликовано: ${formatPrivateControlDateTimeLabel(
        result.nextSendAt,
        result.scheduleTimezone,
      )}.`;
    }

    if (result.failedChats > 0) {
      return `Отправлено: ${result.sentChats}/${result.targetChats}, ошибок: ${result.failedChats}.`;
    }

    if (result.nextSendAt && result.scheduledOccurrences > 0) {
      return `Опубликовано. Следующий слот: ${formatPrivateControlDateTimeLabel(
        result.nextSendAt,
        result.scheduleTimezone,
      )}.`;
    }

    return 'Опубликовано без ошибок.';
  }

  private buildBroadcastSuccessMessage(result: SendBroadcastResult): string {
    if (result.sentChats === 0 && result.nextSendAt) {
      return `✅ Всё успешно. Автопостинг запланирован на ${formatPrivateControlDateTimeLabel(
        result.nextSendAt,
        result.scheduleTimezone,
      )}.`;
    }

    if (result.nextSendAt && result.scheduledOccurrences > 0) {
      return `✅ Всё успешно. Первый слот отправлен, следующий: ${formatPrivateControlDateTimeLabel(
        result.nextSendAt,
        result.scheduleTimezone,
      )}.`;
    }

    return '✅ Всё успешно. Автопостинг отправлен без ошибок.';
  }

  private renderGiveawayClaimView(
    claimContext: {
      giveaway: ManagedGiveawayDetails;
      winner: ManagedGiveawayWinner;
    },
    notice: string | null = null,
  ): PrivateView {
    const { giveaway, winner } = claimContext;
    const statusLabel =
      winner.status === 'DELIVERED'
        ? 'Приз выдан'
        : winner.status === 'EXPIRED'
          ? 'Место ждёт реролл'
          : winner.status === 'SELECTED'
            ? 'Ожидает подтверждения'
            : 'Победитель зафиксирован';
    const lines = [
      privateMarkdownTitle('Розыгрыш'),
      '',
      escapePrivateMarkdown(giveaway.title),
      `${winner.prizePosition}. ${escapePrivateMarkdown(winner.prizeDisplayTitle)}`,
      `Статус: ${statusLabel}`,
      `Победитель: ${escapePrivateMarkdown(winner.displayName ?? winner.userId)}`,
      ...(notice ? ['', `Статус: ${escapePrivateMarkdown(notice)}`] : []),
    ];

    const rows: MaxMessageButton[][] = [];
    const linkRow: MaxMessageButton[] = [];
    if (giveaway.publicationUrl) {
      linkRow.push({
        type: 'link',
        text: 'Открыть пост',
        url: giveaway.publicationUrl,
      });
    }
    if (giveaway.resultsUrl) {
      linkRow.push({
        type: 'link',
        text: 'Итоги',
        url: giveaway.resultsUrl,
      });
    }
    if (linkRow.length > 0) {
      rows.push(linkRow);
    }
    if (winner.status === 'SELECTED') {
      rows.push([
        this.callbackButton(
          'Подтвердить приз',
          this.cb('giveaway_claim_confirm', giveaway.id, winner.id),
          'positive',
        ),
      ]);
    }
    rows.push([this.callbackButton('Главный экран', this.cb('home'))]);

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private renderUnavailableGiveawayClaimView(): PrivateView {
    return {
      text: [
        privateMarkdownTitle('Розыгрыш'),
        '',
        'Итоги уже зафиксированы. Подтверждение победителя больше не требуется.',
      ].join('\n'),
      options: {
        buttons: [[this.callbackButton('Главный экран', this.cb('home'))]],
      },
    };
  }

  private async renderEventsScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const events = await this.adminService.getEvents(session.selectedChatId, context.actor, {
      limit: PAGE_SIZE_EVENTS,
      page: session.eventsPage,
    });

    const hasFullPage = events.length === PAGE_SIZE_EVENTS;

    const lines: string[] = [`События модерации (страница ${session.eventsPage})`, ''];

    if (events.length === 0) {
      lines.push('Событий пока нет.');
    } else {
      lines.push(
        ...events.map((event, index) => {
          const lineIndex = (session.eventsPage - 1) * PAGE_SIZE_EVENTS + index + 1;
          return `${lineIndex}. [${event.action}] ${event.ruleCode} • user ${event.userId} • ${formatPrivateControlIsoDate(event.createdAt)}`;
        }),
      );
    }

    const rows: MaxMessageButton[][] = [
      [
        this.callbackButton(
          '⬅️ Назад',
          this.cb('events_page', String(Math.max(1, session.eventsPage - 1))),
        ),
        this.callbackButton('➡️ Вперёд', this.cb('events_page', String(session.eventsPage + 1))),
      ],
      [
        this.callbackButton('⬅️ Назад', this.cb('back')),
        this.callbackButton('Главный экран', this.cb('home')),
      ],
      ...this.buildFooterButtons(),
    ];

    if (!hasFullPage && session.eventsPage > 1) {
      rows[0][1] = this.callbackButton('🚫 Конец списка', this.cb('noop'));
    }

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderLogsScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const dashboard = await this.adminService.getLogsDashboard(
      session.selectedChatId,
      context.actor,
      {
        range: session.logsRange,
      },
    );

    const lines: string[] = [
      `Сводка и логи (${session.logsRange})`,
      '',
      `Новые участники: ${dashboard.membership.joinedUsers}`,
      `Покинули чат: ${dashboard.membership.leftUsers}`,
      `WARN: ${dashboard.violationsSummary.warn}`,
      `DELETE: ${dashboard.violationsSummary.deleteMessage}`,
      `MUTE: ${dashboard.violationsSummary.mute}`,
      `BAN: ${dashboard.violationsSummary.ban}`,
      `Всего: ${dashboard.violationsSummary.total}`,
      '',
      'Последние нарушения:',
      ...dashboard.violations
        .slice(0, 10)
        .map(
          (violation, index) =>
            `${index + 1}. [${violation.action}] ${violation.ruleCode} • ${violation.userDisplayName ?? violation.userId}`,
        ),
    ];

    const rows: MaxMessageButton[][] = [
      [
        this.callbackButton(
          `${session.logsRange === '24h' ? '✅' : '◻️'} 24h`,
          this.cb('logs_range', '24h'),
        ),
        this.callbackButton(
          `${session.logsRange === '7d' ? '✅' : '◻️'} 7d`,
          this.cb('logs_range', '7d'),
        ),
        this.callbackButton(
          `${session.logsRange === '30d' ? '✅' : '◻️'} 30d`,
          this.cb('logs_range', '30d'),
        ),
      ],
      [
        this.callbackButton('⬅️ Назад', this.cb('back')),
        this.callbackButton('Главный экран', this.cb('home')),
      ],
      ...this.buildFooterButtons(),
    ];

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private async renderManualUsersScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    if (!session.selectedChatId) {
      return this.renderChatSelection(context, session);
    }

    const dashboard = await this.adminService.getLogsDashboard(
      session.selectedChatId,
      context.actor,
      {
        range: session.logsRange,
      },
    );

    const users = dashboard.violations
      .map((violation) => ({
        userId: violation.userId,
        userDisplayName: violation.userDisplayName,
      }))
      .filter(
        (item, index, arr) =>
          arr.findIndex((candidate) => candidate.userId === item.userId) === index,
      );

    const pageInfo = paginatePrivateControlItems(users, session.manualPage, PAGE_SIZE_MANUAL_USERS);
    session.manualPage = pageInfo.page;

    const lines: string[] = [
      `Ручная модерация участников (страница ${pageInfo.page}/${pageInfo.pages})`,
      '',
    ];

    if (users.length === 0) {
      lines.push('За выбранный период нет участников с событиями модерации.');
    } else {
      lines.push(
        ...pageInfo.items.map(
          (entry, index) =>
            `${pageInfo.start + index + 1}. ${entry.userDisplayName ?? 'Без имени'} (${entry.userId})`,
        ),
      );
    }

    const rows: MaxMessageButton[][] = pageInfo.items.map((entry) => [
      this.callbackButton(
        `${compactPrivateText(entry.userDisplayName ?? entry.userId, 20)} (${compactPrivateText(entry.userId, 10)})`,
        this.cb('manual_select_user', entry.userId),
      ),
    ]);

    rows.push(this.paginationButtons(pageInfo.page, pageInfo.pages, 'manual_users_page'));
    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private renderManualActionsScreen(
    targetUserId: string | null,
    notice: string | null = null,
  ): PrivateView {
    if (!targetUserId) {
      return {
        text: 'Сначала выберите участника из списка.',
        options: {
          buttons: [
            [this.callbackButton('К списку пользователей', this.cb('open_manual_users'))],
            ...this.buildFooterButtons(),
          ],
        },
      };
    }

    const lines = [
      'Действия с участником',
      '',
      `Участник: ${targetUserId}`,
      ...(notice ? ['', `Статус: ${notice}`] : []),
    ];

    return {
      text: lines.join('\n'),
      options: {
        buttons: [
          [
            this.callbackButton('Мут', this.cb('manual_action', 'MUTE')),
            this.callbackButton('Бан', this.cb('manual_action', 'BAN'), 'negative'),
          ],
          [
            this.callbackButton('Снять мут', this.cb('manual_action', 'UNMUTE'), 'positive'),
            this.callbackButton('Разбан', this.cb('manual_action', 'UNBAN'), 'positive'),
          ],
          [
            this.callbackButton('⬅️ Назад', this.cb('back')),
            this.callbackButton('Главный экран', this.cb('home')),
          ],
          ...this.buildFooterButtons(),
        ],
      },
    };
  }

  private renderSearchResultsScreen(query: string): PrivateView {
    const matches = settingsRenderer.findSettingMatches(query);
    const lines: string[] = [`Результаты поиска: «${compactPrivateText(query, 60)}»`, ''];

    if (matches.length === 0) {
      lines.push('Ничего не нашёл. Попробуйте другое слово.');
    } else {
      lines.push(
        ...matches.map((item, index) => `${index + 1}. ${item.sectionLabel} • ${item.label}`),
      );
    }

    const rows: MaxMessageButton[][] = matches.map((item) => [
      this.callbackButton(
        `${item.sectionLabel} • ${compactPrivateText(item.label, 26)}`,
        this.cb('search_jump', item.section, String(item.key)),
      ),
    ]);

    rows.push([this.callbackButton('🔎 Новый поиск', this.cb('open_search'))]);
    rows.push([
      this.callbackButton('⬅️ Назад', this.cb('back')),
      this.callbackButton('Главный экран', this.cb('home')),
    ]);
    rows.push(...this.buildFooterButtons());

    return {
      text: lines.join('\n'),
      options: {
        buttons: rows,
      },
    };
  }

  private buildChannelEngagementPublishRequest(
    settings: ChannelSettings,
  ): PublishChannelEngagementRequest {
    if (!settings.commentsEnabled && !settings.postSuggestionsEnabled) {
      throw new BadRequestException(
        'Включите комментарии или предложения постов в настройках канала.',
      );
    }

    return {
      text:
        settings.engagementMessageText.trim() ||
        'Есть идея или обратная связь? Нажмите кнопку ниже.',
      commentsButtonText: '💬 Комментарии',
      suggestButtonText: settings.postSuggestionsButtonText.trim() || '📰 Предложить пост',
    };
  }

  private pushHistory(session: PrivateSession): void {
    const snapshot = JSON.stringify({
      screen: session.screen,
      section: session.section,
      channelSection: session.channelSection,
      sectionView: session.sectionView,
      homeTab: session.homeTab,
      selectedEntityType: session.selectedEntityType,
      managedGiveawayId: session.managedGiveawayId,
      entityTab: session.entityTab,
      domainPage: session.domainPage,
      eventsPage: session.eventsPage,
      manualPage: session.manualPage,
      logsRange: session.logsRange,
      manualTargetUserId: session.manualTargetUserId,
      searchQuery: session.searchQuery,
      broadcastView: session.broadcastView,
    });

    const stack = session.lastScreenStack.slice(-19);
    stack.push(snapshot);
    session.lastScreenStack = stack;
  }

  private restoreFromHistory(session: PrivateSession): boolean {
    if (session.lastScreenStack.length === 0) {
      return false;
    }

    const raw = session.lastScreenStack.pop();
    if (!raw) {
      return false;
    }

    try {
      const row = JSON.parse(raw) as Record<string, unknown>;
      session.screen = parsePrivateControlScreen(row.screen);
      session.section = typeof row.section === 'string' ? this.parseSection(row.section) : null;
      session.channelSection =
        typeof row.channelSection === 'string'
          ? this.parseChannelSection(row.channelSection)
          : null;
      session.sectionView = parsePrivateControlSectionView(row.sectionView);
      session.homeTab = parsePrivateControlHomeTab(row.homeTab);
      session.selectedEntityType = parsePrivateControlEntityType(row.selectedEntityType);
      session.managedGiveawayId =
        typeof row.managedGiveawayId === 'string' && row.managedGiveawayId.trim().length > 0
          ? row.managedGiveawayId.trim()
          : null;
      session.entityTab = parsePrivateControlEntityType(row.entityTab) ?? session.entityTab;
      session.domainPage = toPrivateControlPositiveInt(row.domainPage, 1);
      session.eventsPage = toPrivateControlPositiveInt(row.eventsPage, 1);
      session.manualPage = toPrivateControlPositiveInt(row.manualPage, 1);
      session.logsRange = parsePrivateControlLogsRange(
        typeof row.logsRange === 'string' ? row.logsRange : undefined,
      );
      session.manualTargetUserId =
        typeof row.manualTargetUserId === 'string' && row.manualTargetUserId.trim().length > 0
          ? row.manualTargetUserId.trim()
          : null;
      session.searchQuery =
        typeof row.searchQuery === 'string' && row.searchQuery.trim().length > 0
          ? row.searchQuery.trim()
          : null;
      session.broadcastView = parsePrivateControlBroadcastView(row.broadcastView);
      return true;
    } catch {
      return false;
    }
  }

  private renderInputPrompt(input: PendingInput): PrivateView {
    const prompt = this.describeInputPrompt(input);

    return {
      text: [
        privateMarkdownTitle(`Введите: ${prompt.title}`),
        '',
        escapePrivateMarkdown(prompt.description),
      ].join('\n'),
      options: {
        buttons: [
          [this.callbackButton('Отмена', this.cb('input_cancel'))],
          ...this.buildFooterButtons(),
        ],
      },
    };
  }

  private async renderChannelSuggestionIntroView(
    chatId: string,
    token: string,
  ): Promise<PrivateView> {
    const requirementsText = await this.getChannelSuggestionRequirementsText(chatId);

    return {
      text: [
        privateMarkdownTitle('📰 Предложка'),
        '',
        requirementsText,
        '',
        '⬇️ Пришлите следующим сообщением текст, фото, видео или подпись к медиа.',
      ].join('\n'),
      options: {
        buttons: await this.buildChannelSuggestionIntroButtons(chatId, token),
      },
    };
  }

  private async renderChannelSuggestionSubmittedView(
    chatId: string,
    token: string,
  ): Promise<PrivateView> {
    return {
      text: [
        privateMarkdownTitle('✅ Материал отправлен'),
        '',
        'Бот передал материал редакторам канала на проверку.',
        'Если всё подойдёт, пост опубликуют в канале без лишних шагов.',
        '',
        'Дополнить уже отправленную предложку нельзя: для правок отправьте новую.',
      ].join('\n'),
      options: {
        buttons: await this.buildChannelSuggestionCompletionButtons(chatId, token),
      },
    };
  }

  private async renderChannelSuggestionQueuedView(
    chatId: string,
    token: string,
  ): Promise<PrivateView> {
    return {
      text: [
        privateMarkdownTitle('⏳ Материал принят'),
        '',
        'Материал принят и поставлен в очередь доставки редакторам канала.',
        'Обычно он появляется у редакторов чуть позже без вашего участия.',
        '',
        'Дополнить уже отправленную предложку нельзя: для правок отправьте новую.',
      ].join('\n'),
      options: {
        buttons: await this.buildChannelSuggestionCompletionButtons(chatId, token),
      },
    };
  }

  private async renderChannelSuggestionUndeliveredView(
    chatId: string,
    token: string,
  ): Promise<PrivateView> {
    return {
      text: [
        privateMarkdownTitle('⚠️ Материал сохранён'),
        '',
        'Черновик сохранён, но бот не подтвердил доставку редакторам канала.',
        'Лучше отправить предложку ещё раз или проверить, что редакторы открывали личные сообщения бота.',
        '',
        'Дополнить уже сохранённую предложку нельзя: при правках отправьте новую.',
      ].join('\n'),
      options: {
        buttons: await this.buildChannelSuggestionCompletionButtons(chatId, token),
      },
    };
  }

  private renderChannelSuggestionCancelledView(): PrivateView {
    return {
      text: [
        privateMarkdownTitle('✖️ Предложка закрыта'),
        '',
        'Если захотите отправить материал позже, снова нажмите кнопку под постом.',
      ].join('\n'),
    };
  }

  private renderChannelSuggestionPreviewFallbackView(): PrivateView {
    return {
      text: [
        privateMarkdownTitle('🗂 Черновик предложки'),
        '',
        'Не удалось собрать превью публикации, но черновик сохранён.',
        'Можно отправить ещё текст или медиа, отправить материал админам или вернуться в канал.',
      ].join('\n'),
    };
  }

  private async buildChannelSuggestionIntroButtons(
    chatId: string,
    token: string,
  ): Promise<MaxMessageButton[][]> {
    return [
      [this.callbackButton('✍️ Добавить контент', this.cb('suggestion_compose', chatId, token))],
      [await this.buildChannelSuggestionReturnButton(chatId)],
    ];
  }

  private async buildChannelSuggestionPreviewButtons(
    chatId: string,
  ): Promise<MaxMessageButton[][]> {
    const buttons: MaxMessageButton[][] = [
      [
        this.callbackButton('✏️ Исправить', this.cb('suggestion_edit')),
        this.callbackButton('📨 Отправить', this.cb('suggestion_send'), 'positive'),
      ],
    ];
    const returnButton = await this.buildChannelSuggestionReturnButton(chatId);
    buttons.push([returnButton]);
    return buttons;
  }

  private async buildChannelSuggestionCompletionButtons(
    chatId: string,
    token: string,
  ): Promise<MaxMessageButton[][]> {
    return [
      [this.callbackButton('📰 Предложить ещё', this.cb('suggestion_again', chatId, token))],
      [await this.buildChannelSuggestionReturnButton(chatId)],
    ];
  }

  private async buildChannelSuggestionReturnButton(chatId: string): Promise<MaxMessageButton> {
    try {
      const target = await this.adminService.getPublicChannelSuggestionTarget(chatId);
      if (target.link) {
        return {
          type: 'link',
          text: '↩️ Вернуться в канал',
          url: target.link,
        };
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve channel suggestion return button target',
      );
    }

    return this.callbackButton('↩️ Вернуться в канал', this.cb('input_cancel'));
  }

  private async getChannelSuggestionRequirementsText(chatId: string): Promise<string> {
    const fallback = this.buildDefaultChannelSuggestionRequirementsText();

    try {
      const introText = await this.adminService.getPublicChannelSuggestionIntroText(chatId);
      return introText?.trim() || fallback;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load channel suggestion requirements text',
      );
      return fallback;
    }
  }

  private buildDefaultChannelSuggestionRequirementsText(): string {
    return [
      '1. Готовый текст поста или короткий черновик.',
      '2. Фото или видео, если оно важно для публикации.',
      '3. Ссылку и 1-2 строки контекста, если нужен источник.',
      '',
      'Фото или видео без текста тоже подойдут.',
    ].join('\n');
  }

  private clearChannelSuggestionDraft(session: PrivateSession): void {
    session.suggestionDraft = null;
  }

  private async clearChannelSuggestionPreviewButtons(
    chatId: string,
    previewMessageId: string | null,
    botId?: string,
  ): Promise<void> {
    if (!previewMessageId) {
      return;
    }

    try {
      if (botId) {
        await this.maxClient.editMessageInlineKeyboard(
          chatId,
          previewMessageId,
          null,
          {
            buttons: [],
          },
          { botId },
        );
      } else {
        await this.maxClient.editMessageInlineKeyboard(chatId, previewMessageId, null, {
          buttons: [],
        });
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          previewMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clear channel suggestion preview buttons',
      );
    }
  }

  private async sendChannelSuggestionDraftPreview(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<void> {
    const draft = session.suggestionDraft;
    if (!draft) {
      throw new BadRequestException('Черновик предложки не найден.');
    }
    const botId = this.resolvePrivateDeliveryBotId(context, session);
    assertPrivateSuggestionMediaBot(draft, botId);
    const previousPreviewMessageId = draft.previewMessageId;
    draft.previewMessageId = null;
    await this.clearChannelSuggestionPreviewButtons(
      context.chatId,
      previousPreviewMessageId,
      botId,
    );

    const buttons = await this.buildChannelSuggestionPreviewButtons(draft.chatId);

    try {
      const payload = this.buildChannelSuggestionPreviewPayload(draft, buttons);
      const published = botId
        ? await this.maxClient.sendCustomMessageImmediateWithResolvedLink(context.chatId, payload, {
            botId,
          })
        : await this.maxClient.sendCustomMessageImmediateWithResolvedLink(context.chatId, payload);
      draft.previewMessageId = published.messageId;
      await this.saveSession(context.actor.userId, session);
      return;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId: context.actor.userId,
          chatId: draft.chatId,
          sourceMessageId: draft.sourceMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send channel suggestion preview',
      );
    }

    const fallbackView = this.renderChannelSuggestionPreviewFallbackView();
    await this.saveSession(context.actor.userId, session);
    await this.sendImmediate(
      context.chatId,
      limitPrivateControlMessageText(fallbackView.text),
      this.withDebugContext(
        {
          buttons,
          textFormat: this.shouldUseMarkdown(fallbackView.text) ? 'markdown' : undefined,
        },
        session,
        'suggest_preview_fallback',
      ),
      botId,
    );
  }

  private buildChannelSuggestionPreviewPayload(
    draft: PrivateSuggestionDraft,
    buttons: MaxMessageButton[][],
  ): MaxCustomMessagePayload {
    const textPayload = this.buildSuggestionDraftTextPayload(draft);
    const attachments: Record<string, unknown>[] = [];

    if (draft.images.length > 0) {
      attachments.push(
        ...draft.images.map((image) => ({
          type: image.kind,
          payload: image.payload,
        })),
      );
    } else if (draft.video) {
      attachments.push({
        type: draft.video.kind,
        payload: draft.video.payload,
      });
    }

    const normalizedButtons = normalizeMaxInlineKeyboardButtons(buttons) ?? [];
    if (normalizedButtons.length > 0) {
      attachments.push({
        type: 'inline_keyboard',
        payload: {
          buttons: normalizedButtons,
        },
      });
    }

    return {
      ...(textPayload ? { text: textPayload.text } : {}),
      ...(textPayload?.textFormat ? { textFormat: textPayload.textFormat } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  private renderMassActionConfirmation(pendingMassAction: PendingMassAction): PrivateView {
    const text =
      pendingMassAction.kind === 'apply_section'
        ? [
            privateMarkdownTitle('Подтвердите применение для всех чатов'),
            '',
            `Раздел: ${SECTION_LABELS[pendingMassAction.section]}`,
            `Количество чатов: ${pendingMassAction.targetChats}`,
            '',
            'Применить эти настройки во всех доступных чатах?',
          ].join('\n')
        : [
            privateMarkdownTitle('Подтвердите массовый автопостинг'),
            '',
            `Количество чатов: ${pendingMassAction.targetChats}`,
            '',
            'Отправить автопостинг во все эти чаты?',
          ].join('\n');

    return {
      text,
      options: {
        buttons: [
          [
            this.callbackButton('Да, подтвердить', this.cb('mass_confirm'), 'positive'),
            this.callbackButton('Отмена', this.cb('mass_cancel'), 'negative'),
          ],
          ...this.buildFooterButtons(),
        ],
      },
    };
  }

  private describeInputPrompt(input: PendingInput): { title: string; description: string } {
    if (input.kind === 'set_field' || input.kind === 'set_channel_field') {
      const fieldConfig =
        input.kind === 'set_field'
          ? this.findFieldConfig(input.section, input.key)
          : this.findChannelFieldConfig(input.section, input.key);
      const label = fieldConfig?.label ?? String(input.key);

      if (input.type === 'number') {
        return {
          title: label,
          description: `Введите число${input.min !== undefined ? ` от ${input.min}` : ''}${input.max !== undefined ? ` до ${input.max}` : ''}.`,
        };
      }

      if (input.type === 'time') {
        return {
          title: label,
          description: 'Введите время в формате HH:MM (например 23:00).',
        };
      }

      if (input.type === 'timezone') {
        return {
          title: label,
          description: 'Введите часовой пояс в формате IANA (например Europe/Moscow).',
        };
      }

      if (input.type === 'url') {
        return {
          title: label,
          description: 'Введите ссылку (http/https). Чтобы очистить значение, отправьте `-`.',
        };
      }

      return {
        title: label,
        description: 'Введите новый текст. Чтобы очистить значение, отправьте `-`.',
      };
    }

    switch (input.kind) {
      case 'broadcast_content':
        return {
          title: 'Контент автопостинга',
          description:
            'Отправьте следующим сообщением текст, фото, видео или подпись к медиа. Бот добавит это в черновик.',
        };
      case 'search_settings':
        return {
          title: 'Найти настройку',
          description: 'Введите слово или часть названия параметра (минимум 2 символа).',
        };
      case 'add_domain':
        return {
          title: 'Добавить домен в разрешённые',
          description:
            'Введите точную ссылку или домен. Ссылка с путём сохранится как точная, домен без пути разрешит весь хост.',
        };
      case 'schedule_domain':
        return {
          title: `Дата удаления для ${input.domainLabel}`,
          description:
            'Введите дату: ISO (2026-03-09T18:30:00+03:00) или ДД.ММ.ГГГГ ЧЧ:ММ. Чтобы убрать дату, отправьте `-`.',
        };
      case 'broadcast_text':
        return {
          title: 'Текст автопостинга',
          description: 'Введите текст автопостинга (до 2000 символов).',
        };
      case 'broadcast_button_url':
        return {
          title: 'Ссылка кнопки автопостинга',
          description: 'Введите URL кнопки. Чтобы очистить, отправьте `-`.',
        };
      case 'broadcast_button_text':
        return {
          title: 'Текст кнопки автопостинга',
          description: 'Введите текст кнопки. Чтобы очистить, отправьте `-`.',
        };
      case 'broadcast_send_at':
        return {
          title: 'Время автопостинга',
          description:
            'Введите ISO (2026-03-09T18:30:00+03:00) или ДД.ММ.ГГГГ ЧЧ:ММ. Чтобы отключить таймер, отправьте `-`.',
        };
      case 'broadcast_cycle_every_hours':
        return {
          title: 'Шаг цикла (часы)',
          description: 'Введите число от 1 до 336.',
        };
      case 'broadcast_cycle_count':
        return {
          title: 'Количество повторов цикла',
          description: 'Введите число от 1 до 100.',
        };
      case 'broadcast_photo':
        return {
          title: 'Медиа для автопостинга',
          description: 'Отправьте фото или видео следующим сообщением. Бот добавит его в черновик.',
        };
      case 'rules_text':
        return {
          title: 'Текст правил',
          description: 'Отправьте только текст правил следующим сообщением.',
        };
      case 'rules_photo':
        return {
          title: 'Фото правил',
          description: 'Отправьте только фото или PNG/WebP/JPG файлом следующим сообщением.',
        };
      case 'channel_suggestion':
        return {
          title: 'Требования для предложки',
          description: `Сначала прочитайте требования, затем отправьте текст, фото, видео или подпись к медиа. Можно прислать несколько сообщений подряд: бот обновляет превью после нового текста, фото добавляет в одну подборку до ${MAX_CHANNEL_DIALOG_SUGGEST_IMAGES} шт., а видео заменяет текущие медиа. После отправки дополнить предложку нельзя. Для выхода используйте \`Отмена\`.`,
        };
      case 'giveaway_title':
        return {
          title: 'Служебное название',
          description: 'Введите короткое название для админки.',
        };
      case 'giveaway_content':
        return {
          title: 'Контент розыгрыша',
          description:
            'Пришлите текст публикации. Фото можно добавить сразу подписью к фото или отдельным сообщением. `-` очищает текст.',
        };
      case 'giveaway_description':
        return {
          title: 'Текст публикации',
          description: 'Введите полный текст. Бот отправит его без дописок. `-` очищает поле.',
        };
      case 'giveaway_start_at':
        return {
          title: 'Время старта',
          description: 'Введите дату/время или `-` для старта сразу.',
        };
      case 'giveaway_end_at':
        return {
          title: 'Время завершения',
          description: 'Введите дату и время завершения.',
        };
      case 'giveaway_claim_hours':
        return {
          title: 'Срок подтверждения приза',
          description: 'Введите часы (1-336).',
        };
      case 'giveaway_photo':
        return {
          title: 'Фото публикации',
          description: 'Отправьте фото (опционально).',
        };
      case 'giveaway_prize':
        return {
          title: `Приз ${input.index + 1}`,
          description: 'Введите название приза.',
        };
      case 'manual_mute_duration':
        return {
          title: `Длительность мута для ${input.targetUserId}`,
          description: 'Введите длительность в часах (от 1 до 336).',
        };
      case 'support_request':
        return {
          title: 'Сообщить о проблеме',
          description: 'Опишите проблему одним сообщением. Можно приложить фото.',
        };
    }
  }

  private parseSection(value: string | undefined): PrivateSectionKey | null {
    return parsePrivateControlSection(value);
  }

  private parseChannelSection(value: string | undefined): ChannelSectionKey | null {
    return parsePrivateControlChannelSection(value);
  }

  private findFieldConfig(
    section: PrivateSectionKey,
    key: keyof ChatSettings,
  ): SettingFieldConfig | null {
    const fields = SECTION_FIELDS[section];
    return fields.find((field) => field.key === key) ?? null;
  }

  private findChannelFieldConfig(
    section: ChannelSectionKey,
    key: keyof ChannelSettings,
  ): {
    key: keyof ChannelSettings;
    label: string;
    type: SettingFieldType;
    min?: number;
    max?: number;
  } | null {
    const fields = CHANNEL_SECTION_FIELDS[section];
    return fields.find((field) => field.key === key) ?? null;
  }

  private toggleBroadcastFlag(session: PrivateSession, flag: string): void {
    if (flag === 'apply_to_all') {
      if (session.selectedEntityType === 'channel') {
        session.broadcastDraft.targetMode = 'current';
        session.broadcastDraft.targetChatIds = normalizePrivateBroadcastTargetChatIds(
          session.broadcastDraft.targetChatIds,
          session.selectedChatId,
        );
        session.broadcastDraft.applyToAllChats = false;
        return;
      }
      const nextApplyToAll = !session.broadcastDraft.applyToAllChats;
      session.broadcastDraft.targetMode = nextApplyToAll ? 'all' : 'current';
      session.broadcastDraft.targetChatIds = normalizePrivateBroadcastTargetChatIds(
        session.broadcastDraft.targetChatIds,
        session.selectedChatId,
      );
      session.broadcastDraft.applyToAllChats = nextApplyToAll;
      return;
    }

    if (flag === 'button_enabled') {
      const next = !session.broadcastDraft.buttonEnabled;
      session.broadcastDraft.buttonEnabled = next;
      if (!next) {
        session.broadcastDraft.buttons = [];
        session.broadcastDraft.buttonUrl = '';
        session.broadcastDraft.buttonText = '';
      }
      return;
    }

    if (flag === 'image_enabled') {
      const next = !session.broadcastDraft.imageEnabled;
      session.broadcastDraft.imageEnabled = next;
      if (!next) {
        session.broadcastDraft.imageBase64 = '';
        session.broadcastDraft.imageMimeType = '';
        session.broadcastDraft.imageFileName = '';
      }
      if (next) {
        session.broadcastDraft.mediaType = null;
        session.broadcastDraft.mediaPayload = null;
        session.broadcastDraft.mediaMimeType = '';
        session.broadcastDraft.mediaFileName = '';
      }
      return;
    }

    if (flag === 'cycle_enabled') {
      const next = !session.broadcastDraft.cycleEnabled;
      session.broadcastDraft.cycleEnabled = next;
      if (!next) {
        session.broadcastDraft.cycleEveryHours = 24;
        session.broadcastDraft.cycleCount = 1;
      }
    }
  }

  private buildBroadcastPendingInput(flag: string): PendingInput | null {
    if (flag === 'content') {
      return { kind: 'broadcast_content' };
    }

    if (flag === 'text') {
      return { kind: 'broadcast_text' };
    }

    if (flag === 'button_url') {
      return { kind: 'broadcast_button_url' };
    }

    if (flag === 'button_text') {
      return { kind: 'broadcast_button_text' };
    }

    if (flag === 'send_at') {
      return { kind: 'broadcast_send_at' };
    }

    if (flag === 'cycle_hours') {
      return { kind: 'broadcast_cycle_every_hours' };
    }

    if (flag === 'cycle_count') {
      return { kind: 'broadcast_cycle_count' };
    }

    if (flag === 'photo') {
      return { kind: 'broadcast_photo' };
    }

    return null;
  }

  private async respond(
    context: PrivateContext,
    session: PrivateSession,
    view: PrivateView,
    callback: { callbackId: string | null; notification: string | null },
  ): Promise<void> {
    await this.saveSession(context.actor.userId, session);

    const text = limitPrivateControlMessageText(view.text);
    const compactOptions = this.compactButtonLayout(view.options);
    const inferredTextFormat =
      compactOptions?.textFormat ?? (this.shouldUseMarkdown(text) ? 'markdown' : undefined);
    const optionsWithFormat = inferredTextFormat
      ? { ...(compactOptions ?? {}), textFormat: inferredTextFormat }
      : compactOptions;
    const options = this.withDebugContext(optionsWithFormat, session, callback.notification);
    const botId = this.resolvePrivateDeliveryBotId(context, session);

    if (callback.callbackId) {
      const edited = await this.tryAnswerWithEdit(
        callback.callbackId,
        callback.notification ?? 'Готово',
        text,
        options,
        this.privateCallbackEditTimeoutMs,
        botId,
        context.chatId,
      );
      if (edited) {
        return;
      }

      await this.answerCallbackQuiet(
        callback.callbackId,
        callback.notification ?? 'Готово',
        this.privateCallbackAckTimeoutMs,
        botId,
        context.chatId,
      );
    }

    await this.sendImmediate(context.chatId, text, options, botId);
  }

  private async respondWithFreshMessage(
    context: PrivateContext,
    session: PrivateSession,
    view: PrivateView,
    callback: { callbackId: string | null; notification: string | null },
  ): Promise<void> {
    const botId = this.resolvePrivateDeliveryBotId(context, session);
    if (callback.callbackId) {
      await this.answerCallbackQuiet(
        callback.callbackId,
        callback.notification ?? 'Готово',
        this.privateCallbackAckTimeoutMs,
        botId,
        context.chatId,
      );
    }

    await this.respond(context, session, view, {
      callbackId: null,
      notification: null,
    });
  }

  private async sendImmediate(
    chatId: string,
    text: string,
    options?: MaxSendMessageOptions,
    botId?: string,
  ): Promise<void> {
    try {
      await this.maxClient.sendMessage(chatId, text, options, {
        immediate: true,
        ignoreFailureMetricStatuses: PRIVATE_DIALOG_TERMINAL_FAILURE_METRIC_STATUSES,
        timeoutMs: this.privateDialogSendTimeoutMs,
        ...(botId ? { botId } : {}),
      });
    } catch (error: unknown) {
      if (this.isTerminalPrivateDialogDeliveryError(error)) {
        this.logger.debug(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Skipped private dialog delivery after terminal MAX API error',
        );
        return;
      }

      throw error;
    }
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
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

  private rememberPrivateChatRoute(session: PrivateSession, context: PrivateContext): void {
    if (!this.isPrivateDirectChat(context.chatId)) {
      return;
    }

    const botId = this.readUpdateBotId(context.update);
    const previousPrivateChatId = session.lastPrivateChatId;
    const rememberedBotId = session.lastPrivateBotId?.trim() || null;
    if (session.lastPrivateChatId !== context.chatId) {
      session.lastPrivateChatId = context.chatId;
      session.lastPrivateBotId = botId ?? (previousPrivateChatId ? null : rememberedBotId);
      return;
    }

    session.lastPrivateChatId = context.chatId;
    if (botId) {
      session.lastPrivateBotId = botId;
    }
  }

  private resolvePrivateDeliveryBotId(
    context: PrivateContext,
    session?: PrivateSession | null,
  ): string | undefined {
    const updateBotId = this.readUpdateBotId(context.update);
    if (updateBotId) {
      return updateBotId;
    }

    if (session?.lastPrivateChatId === context.chatId) {
      return session.lastPrivateBotId?.trim() || undefined;
    }

    return undefined;
  }

  private readUpdateBotId(update: MaxUpdate): string | null {
    return typeof update.botId === 'string' && update.botId.trim().length > 0
      ? update.botId.trim()
      : null;
  }

  private buildPrivateControlMediaUploader(
    context: PrivateContext,
    session: PrivateSession,
  ): PrivateControlMediaAttachmentUploader {
    const botId = this.resolvePrivateDeliveryBotId(context, session);
    if (!botId) {
      return this.privateControlMediaUploader;
    }

    return {
      uploadImage: (data, fileName, mimeType) =>
        this.maxClient.uploadImage(data, fileName, mimeType, { botId }),
      uploadVideo: (data, fileName, mimeType) =>
        this.maxClient.uploadVideo(data, fileName, mimeType, { botId }),
    };
  }

  private createSyntheticPrivateContext(
    user: AuthUser,
    privateChatId: string,
    botId?: string | null,
  ): PrivateContext {
    return {
      update: {
        updateId: 'miniapp-handoff',
        ...(botId?.trim() ? { botId: botId.trim() } : {}),
        type: 'message_created',
        message: {
          messageId: 'miniapp-handoff',
          chatId: privateChatId,
          senderId: user.userId,
          senderName: user.displayName ?? user.username ?? user.userId,
          text: '',
          createdAt: new Date().toISOString(),
        },
      } as MaxUpdate,
      chatId: privateChatId,
      actor: {
        ...user,
        chatId: privateChatId,
      },
      text: '',
      callbackId: null,
      callbackPayload: null,
    };
  }

  private async deliverBroadcastHandoffToKnownPrivateChat(
    user: AuthUser,
    session: PrivateSession,
  ): Promise<void> {
    await this.deliverScreenHandoffToKnownPrivateChat(user, session, 'broadcast');
  }

  private async deliverGiveawayHandoffToKnownPrivateChat(
    user: AuthUser,
    session: PrivateSession,
  ): Promise<void> {
    await this.deliverScreenHandoffToKnownPrivateChat(user, session, 'giveaway');
  }

  private async deliverRulesHandoffToKnownPrivateChat(
    user: AuthUser,
    session: PrivateSession,
  ): Promise<void> {
    await this.deliverScreenHandoffToKnownPrivateChat(user, session, 'rules');
  }

  private async deliverScreenHandoffToKnownPrivateChat(
    user: AuthUser,
    session: PrivateSession,
    kind: PrivateScreenHandoffKind,
  ): Promise<void> {
    await deliverPrivateScreenHandoffToKnownPrivateChat(session, kind, {
      createContext: (privateChatId) =>
        this.createSyntheticPrivateContext(user, privateChatId, session.lastPrivateBotId),
      render: (context, currentSession) => this.renderByCurrentScreen(context, currentSession),
      respond: (context, currentSession, view) =>
        this.respond(context, currentSession, view, {
          callbackId: null,
          notification: null,
        }),
      saveSession: (currentSession) => this.saveSession(user.userId, currentSession),
      onFailure: (error, privateChatId) => {
        this.logger.warn(
          {
            userId: user.userId,
            chatId: privateChatId,
            err: error instanceof Error ? error.message : String(error),
          },
          `Failed to proactively deliver ${kind} handoff to private chat`,
        );
      },
    });
  }

  private async sendProfileMentionToPrivateChat(
    privateChatId: string,
    displayName: string,
    userId: string,
    botId?: string,
  ): Promise<void> {
    const message = renderPrivateProfileMentionMessage({
      displayName,
      userId,
    });
    await this.sendImmediate(privateChatId, message.text, message.options, botId);
  }

  private async resolveProfileMentionDisplayName(
    sourceChatId: string,
    userId: string,
    fallbackDisplayName: string,
    botId?: string,
  ): Promise<string> {
    const fallback = fallbackDisplayName.trim() || 'Пользователь';
    if (fallback !== 'Пользователь') {
      return fallback;
    }

    try {
      const profiles = botId
        ? await this.maxClient.getChatMemberProfiles(sourceChatId, [userId], { botId })
        : await this.maxClient.getChatMemberProfiles(sourceChatId, [userId]);
      const resolvedDisplayName = readPrivateControlString(profiles.get(userId)?.displayName);
      if (resolvedDisplayName) {
        await this.persistResolvedProfileDisplayName(sourceChatId, userId, resolvedDisplayName);
        return resolvedDisplayName;
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: sourceChatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve compact profile mention display name from MAX',
      );
    }

    return (await this.resolveLocalProfileMentionDisplayName(sourceChatId, userId)) || fallback;
  }

  private async resolveLocalProfileMentionDisplayName(
    sourceChatId: string,
    userId: string,
  ): Promise<string | null> {
    const normalizedChatId = sourceChatId.trim();
    const normalizedUserId = userId.trim();
    if (!this.prisma || !normalizedChatId || !normalizedUserId) {
      return null;
    }

    try {
      const snapshot = await this.prisma.chatUserDisplayName.findUnique({
        where: {
          chatId_userId: {
            chatId: normalizedChatId,
            userId: normalizedUserId,
          },
        },
        select: {
          displayName: true,
        },
      });
      return readPrivateControlString(snapshot?.displayName);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          userId: normalizedUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve profile handoff display name from local snapshot',
      );
      return null;
    }
  }

  private async persistResolvedProfileDisplayName(
    chatId: string,
    userId: string,
    displayName: string,
  ): Promise<void> {
    const normalizedChatId = chatId.trim();
    const normalizedUserId = userId.trim();
    const normalizedDisplayName = displayName.trim();
    if (
      !normalizedChatId ||
      !normalizedUserId ||
      !normalizedDisplayName ||
      isPrivateDirectChatId(normalizedChatId)
    ) {
      return;
    }

    const observedAt = new Date();
    const upsert = buildChatUserDisplayNameUpsert([
      {
        chatId: normalizedChatId,
        userId: normalizedUserId,
        displayName: normalizedDisplayName,
        observedAt,
        sourceEventId: `profile_handoff:${observedAt.toISOString()}:${normalizedUserId}`,
        sourceKind: 'profile_handoff',
      },
    ]);
    if (!upsert || !this.prisma) {
      return;
    }

    try {
      await this.prisma.$executeRaw(upsert);
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          userId: normalizedUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist profile handoff display name snapshot',
      );
    }
  }

  private resolveManagedEntityHeaderBotId(header: ManagedEntityHeader): string | undefined {
    const primaryBotId = readPrivateControlString(header.primaryBotId);
    if (primaryBotId) {
      return primaryBotId;
    }

    const assignedBots = header.assignedBots ?? [];
    const assignedBot =
      assignedBots.find(
        (bot) =>
          bot.role === 'primary' &&
          bot.membershipStatus !== 'removed' &&
          bot.lifecycleState !== 'disabled' &&
          readPrivateControlString(bot.botId),
      ) ??
      assignedBots.find(
        (bot) =>
          bot.membershipStatus !== 'removed' &&
          bot.lifecycleState !== 'disabled' &&
          readPrivateControlString(bot.botId),
      );

    return readPrivateControlString(assignedBot?.botId) ?? undefined;
  }

  private async deliverProfileMentionHandoffToKnownPrivateChat(
    user: AuthUser,
    session: PrivateSession,
    payload: { displayName: string; userId: string },
  ): Promise<void> {
    await deliverPrivateProfileMentionHandoffToKnownPrivateChat(session, payload, {
      send: (privateChatId, message) =>
        this.sendImmediate(
          privateChatId,
          message.text,
          message.options,
          session.lastPrivateBotId?.trim() || undefined,
        ),
      saveSession: (currentSession) => this.saveSession(user.userId, currentSession),
      onFailure: (error, privateChatId) => {
        this.logger.warn(
          {
            userId: user.userId,
            chatId: privateChatId,
            targetUserId: payload.userId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to proactively deliver profile mention handoff to private chat',
        );
      },
    });
  }

  private compactButtonLayout(
    options: MaxSendMessageOptions | undefined,
  ): MaxSendMessageOptions | undefined {
    if (!options) {
      return undefined;
    }

    const compactSingleButton = options.button
      ? {
          ...options.button,
          text: compactPrivateText(options.button.text, BUTTON_TEXT_MAX_SINGLE_COLUMN),
        }
      : undefined;

    const compactGrid = options.buttons?.map((row) => {
      const maxLength =
        row.length >= 2 ? BUTTON_TEXT_MAX_TWO_COLUMNS : BUTTON_TEXT_MAX_SINGLE_COLUMN;
      return row.map((button) => ({
        ...button,
        text: compactPrivateText(button.text, maxLength),
      }));
    });

    return {
      ...options,
      ...(compactSingleButton ? { button: compactSingleButton } : {}),
      ...(compactGrid ? { buttons: compactGrid } : {}),
    };
  }

  private shouldUseMarkdown(text: string): boolean {
    return containsSupportedMarkdownSyntax(text);
  }

  private buildSuggestionDraftTextPayload(
    draft: Pick<PrivateSuggestionDraft, 'text' | 'textFormat' | 'textMarkup'>,
  ): { text: string; textFormat?: MaxSendMessageOptions['textFormat'] } | null {
    if (!draft.text) {
      return null;
    }

    if (draft.textMarkup.length > 0) {
      return {
        text: renderMaxTextMarkupAsHtml(draft.text, draft.textMarkup) ?? draft.text,
        textFormat: 'html',
      };
    }

    if (draft.textFormat === 'markdown') {
      return {
        text: renderSupportedMarkdownAsHtml(draft.text, {
          blockMode: 'raw',
        }),
        textFormat: 'html',
      };
    }

    return {
      text: draft.text,
    };
  }

  private withDebugContext(
    options: MaxSendMessageOptions | undefined,
    session: PrivateSession,
    action: string | null,
  ): MaxSendMessageOptions | undefined {
    if (!options) {
      return undefined;
    }

    return {
      ...options,
      debugContext: {
        ...(options.debugContext ?? {}),
        screen: session.screen,
        ...(action ? { action: action.slice(0, 64) } : {}),
      },
    };
  }

  private async tryAnswerWithEdit(
    callbackId: string,
    notification: string,
    text: string,
    options?: MaxSendMessageOptions,
    timeoutMs?: number,
    botId?: string,
    rateLimitEntityId?: string,
  ): Promise<boolean> {
    try {
      await this.maxClient.answerCallback(
        callbackId,
        notification,
        {
          text,
          options,
        },
        {
          ignoreFailureMetricStatuses: CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
          ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
          ...(botId ? { botId } : {}),
          ...(rateLimitEntityId ? { rateLimitEntityId } : {}),
        },
      );
      return true;
    } catch (error: unknown) {
      this.logger.debug(
        {
          callbackId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Callback edit failed, fallback to sendMessage',
      );
      return false;
    }
  }

  private async answerCallbackQuiet(
    callbackId: string,
    notification: string,
    timeoutMs?: number,
    botId?: string,
    rateLimitEntityId?: string,
  ): Promise<void> {
    try {
      await this.maxClient.answerCallback(callbackId, notification, undefined, {
        ignoreFailureMetricStatuses: CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
        ...(botId ? { botId } : {}),
        ...(rateLimitEntityId ? { rateLimitEntityId } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          callbackId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Callback answer failed',
      );
    }
  }

  private async handlePrivateControlError(
    context: PrivateContext,
    callback: CallbackAction | null,
    error: unknown,
  ): Promise<void> {
    const badRequestDetails = extractPrivateControlUserErrorDetails(error);
    const userMessage =
      typeof badRequestDetails === 'string' && badRequestDetails.trim().length > 0
        ? badRequestDetails
        : 'Что-то пошло не так. Попробуйте ещё раз через несколько секунд.';
    const session = await this.loadSessionForDiagnostics(context.actor.userId);
    const badRequestResponse = error instanceof BadRequestException ? error.getResponse() : null;

    this.logger.warn(
      {
        chatId: context.chatId,
        userId: context.actor.userId,
        err: error instanceof Error ? error.message : String(error),
        badRequestDetails,
        ...(badRequestResponse ? { badRequestResponse } : {}),
        callbackAction: callback?.action ?? null,
        callbackArgs: callback?.args ?? [],
        callbackPayload: context.callbackPayload,
        selectedChatId: session?.selectedChatId ?? null,
        selectedEntityType: session?.selectedEntityType ?? null,
        screen: session?.screen ?? null,
        pendingInput: session?.pendingInput?.kind ?? null,
        pendingMassAction: session?.pendingMassAction?.kind ?? null,
      },
      'Private control flow failed',
    );

    await this.sendImmediate(
      context.chatId,
      userMessage,
      undefined,
      this.resolvePrivateDeliveryBotId(context, session),
    );
  }

  private async awaitWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(message) as Error & { code?: string };
        error.code = 'PRIVATE_CONTROL_TIMEOUT';
        reject(error);
      }, timeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private isTimeoutError(error: unknown): boolean {
    return (error as { code?: unknown })?.code === 'PRIVATE_CONTROL_TIMEOUT';
  }

  private callbackButton(
    text: string,
    payload: string,
    intent: 'default' | 'positive' | 'negative' = 'default',
  ): MaxMessageButton {
    return buildPrivateCallbackButton(text, payload, intent);
  }

  private buildFooterButtons(config?: {
    includeMiniapp?: boolean;
    includeSupport?: boolean;
    includeProblemReport?: boolean;
    singleColumn?: boolean;
    supportText?: string;
    miniappText?: string;
    miniappRoute?: string | null;
    miniappUrl?: string | null;
  }): MaxMessageButton[][] {
    const row: MaxMessageButton[] = [];
    const includeMiniapp = config?.includeMiniapp !== false;
    const includeSupport = config?.includeSupport !== false;
    const includeProblemReport = config?.includeProblemReport === true;
    const miniappRoute = config?.miniappRoute?.trim() || '/';
    const miniappUrl = config?.miniappUrl ?? this.resolveMiniappUrl();
    const miniappText = config?.miniappText?.trim() || '📱 Приложение';
    const miniappLaunchUrl = this.buildMiniappRouteLaunchUrl(miniappRoute);

    if (includeMiniapp && (miniappLaunchUrl || miniappUrl)) {
      row.push(this.buildMiniappLaunchButton(miniappText, miniappRoute, miniappUrl));
    }

    if (includeSupport) {
      row.push({
        type: 'link',
        text: config?.supportText?.trim() || '🆘 Поддержка',
        url: SUPPORT_CHAT_URL,
      });
    }

    const rows: MaxMessageButton[][] =
      config?.singleColumn === true ? row.map((button) => [button]) : row.length > 0 ? [row] : [];
    if (includeProblemReport) {
      rows.push([this.callbackButton('Сообщить о проблеме', this.cb('support_report'))]);
    }

    return rows;
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

    if (fallbackWebAppUrl) {
      return this.buildMiniappOpenButton(text, fallbackWebAppUrl);
    }

    return {
      type: 'link',
      text,
      url: 'https://major-maksimov.ru/app/',
    };
  }

  private buildMiniappOpenButton(text: string, webAppUrl: string): MaxMessageButton {
    const botContactId = this.resolveBotContactId();
    if (botContactId) {
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
      url: webAppUrl,
    };
  }

  private paginationButtons(page: number, pages: number, action: string): MaxMessageButton[] {
    return [
      this.callbackButton('⬅️', this.cb(action, String(Math.max(1, page - 1)))),
      this.callbackButton(`${page}/${pages}`, this.cb('noop')),
      this.callbackButton('➡️', this.cb(action, String(Math.min(pages, page + 1)))),
    ];
  }

  private cb(action: string, ...args: string[]): string {
    return buildPrivateCallbackPayload(action, ...args);
  }

  private resolveMiniappUrl(): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app/`;
  }

  private buildEntitySettingsMiniappRoute(
    chatId: string,
    entityType: ManagedEntityType,
    focus?: string | null,
  ): string {
    const encodedChatId = encodeURIComponent(chatId);
    const baseRoute =
      entityType === 'channel'
        ? `/channel/${encodedChatId}/settings`
        : `/chat/${encodedChatId}/settings`;
    const normalizedFocus = focus?.trim();
    return normalizedFocus
      ? `${baseRoute}?focus=${encodeURIComponent(normalizedFocus)}`
      : baseRoute;
  }

  private buildEntityActivityMiniappUrl(
    chatId: string,
    entityType: ManagedEntityType,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app${this.buildEntityActivityMiniappRoute(chatId, entityType)}`;
  }

  private buildEntityActivityMiniappRoute(chatId: string, entityType: ManagedEntityType): string {
    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `/channel/${encodedChatId}/stats`
      : `/chat/${encodedChatId}/events`;
  }

  private buildBroadcastSettingsMiniappUrl(
    chatId: string,
    entityType: ManagedEntityType,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `${this.appBaseUrl}/app/channel/${encodedChatId}/settings?focus=broadcast&handoff=1`
      : `${this.appBaseUrl}/app/chat/${encodedChatId}/settings?focus=broadcast&handoff=1`;
  }

  private buildBroadcastSettingsMiniappRoute(
    chatId: string,
    entityType: ManagedEntityType,
  ): string {
    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `/channel/${encodedChatId}/settings?focus=broadcast&handoff=1`
      : `/chat/${encodedChatId}/settings?focus=broadcast&handoff=1`;
  }

  private buildRulesSettingsMiniappUrl(chatId: string): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const encodedChatId = encodeURIComponent(chatId);
    return `${this.appBaseUrl}/app/chat/${encodedChatId}/settings?focus=rules&handoff=1`;
  }

  private buildRulesSettingsMiniappRoute(chatId: string): string {
    return `/chat/${encodeURIComponent(chatId)}/settings?focus=rules&handoff=1`;
  }

  private buildEntitySettingsHandoffMiniappUrl(
    chatId: string,
    entityType: ManagedEntityType,
    focus?: string | null,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app${this.buildEntitySettingsHandoffMiniappRoute(
      chatId,
      entityType,
      focus,
    )}`;
  }

  private buildEntitySettingsHandoffMiniappRoute(
    chatId: string,
    entityType: ManagedEntityType,
    focus?: string | null,
  ): string {
    const baseRoute = this.buildEntitySettingsMiniappRoute(chatId, entityType, focus);
    return baseRoute.includes('?') ? `${baseRoute}&handoff=1` : `${baseRoute}?handoff=1`;
  }

  private resetSessionToPrimaryScreen(session: PrivateSession): void {
    session.screen = this.resolvePrimaryScreen(session);
    session.section = null;
    session.channelSection = null;
    session.pendingInput = null;
    session.pendingMassAction = null;
    session.searchQuery = null;
    session.manualTargetUserId = null;
  }

  private async renderMiniappMovedScreen(
    context: PrivateContext,
    session: PrivateSession,
    config: {
      title: string;
      description: string;
      buttonText: string;
      miniappRoute: string;
      miniappUrl: string | null;
      includeBackButton?: boolean;
    },
  ): Promise<PrivateView> {
    const entityType = session.selectedEntityType ?? 'chat';
    const entityLabel = entityType === 'channel' ? 'Канал' : 'Чат';
    const entityTitle = session.selectedChatId
      ? await this.resolveManagedEntityTitle(context.actor, entityType, session.selectedChatId)
      : null;
    return renderPrivateMiniappMovedView({
      title: config.title,
      description: config.description,
      entityLabel,
      entityTitle,
      launchButton: this.buildMiniappLaunchButton(
        config.buttonText,
        config.miniappRoute,
        config.miniappUrl,
      ),
      backButton:
        config.includeBackButton === false
          ? null
          : this.callbackButton('↩️ Назад', this.cb('back')),
      footerButtons: this.buildFooterButtons({ includeMiniapp: false }),
    });
  }

  private async renderEntitySettingsMovedToMiniappScreen(
    context: PrivateContext,
    session: PrivateSession,
    focus?: string | null,
    config?: legacyHoldAdvisory.PrivateSettingsHandoffConfig,
  ): Promise<PrivateView> {
    const entityType = session.selectedEntityType ?? 'chat';
    const chatId = session.selectedChatId ?? context.chatId;
    return this.renderMiniappMovedScreen(context, session, {
      title: config?.title ?? 'Настройки перенесены в mini app',
      description: await this.describeChatHolds(context.actor.userId, session, config?.description),
      buttonText: config?.buttonText ?? '📱 Открыть в приложении',
      miniappRoute: this.buildEntitySettingsHandoffMiniappRoute(chatId, entityType, focus),
      miniappUrl: this.buildEntitySettingsHandoffMiniappUrl(chatId, entityType, focus),
    });
  }

  private async renderEntityActivityMovedToMiniappScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    const entityType = session.selectedEntityType ?? 'chat';
    const chatId = session.selectedChatId ?? context.chatId;
    return this.renderMiniappMovedScreen(context, session, {
      title: 'Активность открывается в mini app',
      description: 'События, логи и ручная модерация теперь доступны в экране активности mini app.',
      buttonText: entityType === 'channel' ? '📱 Открыть статистику' : '📱 Открыть активность',
      miniappRoute: this.buildEntityActivityMiniappRoute(chatId, entityType),
      miniappUrl: this.buildEntityActivityMiniappUrl(chatId, entityType),
    });
  }

  private renderLauncherHomeView(notice: string | null = null): PrivateView {
    const profile = this.resolveActiveBotSpeechProfile();
    return renderPrivateLauncherHomeView({
      profile,
      appBaseUrl: this.appBaseUrl,
      notice,
      footerButtons: [
        ...this.buildFooterButtons({ includeProblemReport: true, singleColumn: true }),
        [
          {
            type: 'link',
            text: 'Открыть бота Публик',
            url: `https://max.ru/${this.publisherBotId}`,
          },
        ],
      ],
    });
  }

  private renderLauncherIntroView(): PrivateView {
    const profile = this.resolveActiveBotSpeechProfile();
    return renderPrivateLauncherIntroView({
      profile,
      appBaseUrl: this.appBaseUrl,
      footerButtons: this.buildFooterButtons({
        includeProblemReport: true,
        singleColumn: true,
        supportText: '🆘 Техпомощь',
      }),
    });
  }

  private resolveActiveBotSpeechProfile(): ActiveBotSpeechProfile {
    const activeBotId = this.maxBotLinkService?.getContextOrDefaultBotId() ?? null;
    const bot = this.maxBotLinkService?.getResolvedBotSync(activeBotId);
    const characterName = bot?.characterName?.trim() || bot?.label?.trim() || 'Майор Максимов';

    return {
      persona: bot?.speechPersona ?? 'male',
      characterName,
    };
  }

  private launcherIntroMarkerKey(userId: string): string {
    return `private-control:launcher-intro:v2:${userId}`;
  }

  private async hasDeliveredLauncherIntro(userId: string): Promise<boolean> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return true;
    }

    if (this.launcherIntroSeenUsers.has(normalizedUserId)) {
      return true;
    }

    try {
      const cached = await this.redisCounter?.getString(
        this.launcherIntroMarkerKey(normalizedUserId),
      );
      if (cached === '1') {
        this.launcherIntroSeenUsers.add(normalizedUserId);
        return true;
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          userId: normalizedUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read launcher intro marker',
      );
    }

    return false;
  }

  private async markLauncherIntroDelivered(userId: string): Promise<void> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return;
    }

    this.launcherIntroSeenUsers.add(normalizedUserId);
    try {
      await this.redisCounter?.setStringWithTtl(
        this.launcherIntroMarkerKey(normalizedUserId),
        '1',
        LAUNCHER_INTRO_MARKER_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          userId: normalizedUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist launcher intro marker',
      );
    }
  }

  private async renderEntityBroadcastMovedToMiniappScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    return this.renderEntitySettingsMovedToMiniappScreen(context, session, 'broadcast', {
      title: 'Параметры автопостинга в mini app',
      description:
        'В боте остался только быстрый composer: пришлите контент, проверьте превью и подтвердите публикацию.',
    });
  }

  private async renderEntityRulesMovedToMiniappScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    return this.renderEntitySettingsMovedToMiniappScreen(context, session, 'rules', {
      title: 'Настройки правил в mini app',
      description:
        'В боте можно только быстро обновить текст или фото правил и опубликовать результат.',
    });
  }

  private async renderEntityGiveawayMovedToMiniappScreen(
    context: PrivateContext,
    session: PrivateSession,
  ): Promise<PrivateView> {
    return this.renderEntitySettingsMovedToMiniappScreen(context, session, 'giveaway', {
      title: 'Розыгрыши перенесены в mini app',
      description:
        'Черновики, публикация, итоги и reroll розыгрышей теперь доступны только в приложении.',
    });
  }

  private async renderEntityChannelSettingsMovedToMiniappScreen(
    context: PrivateContext,
    session: PrivateSession,
    rawSection: string | undefined,
  ): Promise<PrivateView> {
    const focus =
      rawSection === 'comments'
        ? 'comments'
        : rawSection === 'post_suggestions'
          ? 'postSuggestions'
          : null;
    const description =
      focus === 'comments'
        ? 'Комментарии и реакции канала теперь настраиваются только в приложении.'
        : focus === 'postSuggestions'
          ? 'Кнопка предложки, лимиты и сценарии публикации теперь настраиваются только в приложении.'
          : 'Настройки канала перенесены в mini app.';

    return this.renderEntitySettingsMovedToMiniappScreen(context, session, focus, {
      title: 'Настройки канала в mini app',
      description,
    });
  }

  private buildGiveawaySettingsMiniappUrl(
    chatId: string,
    entityType: ManagedEntityType,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `${this.appBaseUrl}/app/channel/${encodedChatId}/settings?focus=giveaway&handoff=1`
      : `${this.appBaseUrl}/app/chat/${encodedChatId}/settings?focus=giveaway&handoff=1`;
  }

  private buildGiveawaySettingsMiniappRoute(chatId: string, entityType: ManagedEntityType): string {
    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `/channel/${encodedChatId}/settings?focus=giveaway&handoff=1`
      : `/chat/${encodedChatId}/settings?focus=giveaway&handoff=1`;
  }

  private buildMiniappRouteLaunchUrl(route: string): string | null {
    return this.buildMiniappStartUrl(this.buildMiniappRouteStartParam(route));
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

  private buildMiniappStartUrl(startParam: string): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildEntryMiniappStartUrlSync?.(startParam) ??
      this.maxBotLinkService?.buildMiniappStartUrlSync?.(startParam) ??
      (this.botDeepLinkId
        ? `https://max.ru/${encodeURIComponent(this.botDeepLinkId)}?startapp=${encodeURIComponent(startParam)}`
        : null)
    );
  }

  private buildBotStartUrl(startPayload: string, botId?: string | null): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildBotStartUrlSync?.(startPayload, botId) ??
      (this.botDeepLinkId
        ? `https://max.ru/${encodeURIComponent(botId?.trim() || this.botDeepLinkId)}?start=${encodeURIComponent(startPayload)}`
        : null)
    );
  }

  private buildGiveawayHandoffStartPayload(
    params: {
      chatId: string;
      entityType: ManagedEntityType;
      giveawayId: string | null;
    },
    botId?: string | null,
  ): string {
    return buildPrivateGiveawayHandoffStartPayload(params, this.getCurrentBotToken(botId));
  }

  private buildProfileMentionStartPayload(
    params: {
      chatId: string;
      entityType: ManagedEntityType;
      userId: string;
      displayName: string;
    },
    botId?: string | null,
  ): string {
    return buildPrivateProfileMentionStartPayload(params, this.getCurrentBotToken(botId));
  }

  private buildKaravanAllowlistStartPayload(
    params: { chatId: string; actorUserId: string; nonce: string },
    botId?: string | null,
  ): string {
    return buildPrivateKaravanAllowlistStartPayload(params, this.getCurrentBotToken(botId));
  }

  private parseKaravanAllowlistStartPayload(
    startPayload: string | null,
  ): { chatId: string; actorUserId: string; nonce: string } | null {
    return parsePrivateKaravanAllowlistStartPayload(
      startPayload,
      this.maxBotTokenValidationSecrets,
    );
  }

  private createKaravanAllowlistNonce(): string {
    return randomBytes(12).toString('base64url');
  }

  private parseGiveawayHandoffStartPayload(
    startPayload: string | null,
  ): { chatId: string; entityType: ManagedEntityType; giveawayId: string | null } | null {
    return parsePrivateGiveawayHandoffStartPayload(startPayload, this.maxBotTokenValidationSecrets);
  }

  private parseProfileMentionStartPayload(
    startPayload: string | null,
  ): { chatId: string; entityType: ManagedEntityType; userId: string; displayName: string } | null {
    return parsePrivateProfileMentionStartPayload(startPayload, this.maxBotTokenValidationSecrets);
  }

  private resolveBotContactId(): string | null {
    const contextAwareContactId = this.maxBotLinkService?.resolveContactIdSync();
    if (contextAwareContactId) {
      return contextAwareContactId;
    }

    if (this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    if (!this.ownBotUserId) {
      return null;
    }

    const [candidate] = this.ownBotUserId.split('_');
    return /^\d+$/.test(candidate) ? candidate : null;
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

  private normalizeBotDeepLinkId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private parseCallbackAction(payload: string | null): CallbackAction | null {
    if (!payload) {
      return null;
    }

    const parts = payload.split('|');
    if (parts.length < 2) {
      return null;
    }

    if (parts[0] !== MAX_CALLBACK_PREFIX && parts[0] !== LEGACY_CALLBACK_PREFIX) {
      return null;
    }

    return {
      action: parts[1],
      args: parts.slice(2),
    };
  }

  private hasRetiredPublishingSession(session: PrivateSession): boolean {
    return (
      session.screen === 'broadcast' ||
      session.pendingInput?.kind.startsWith('broadcast_') === true ||
      session.pendingMassAction?.kind === 'broadcast'
    );
  }

  private renderPublikHandoff(session: PrivateSession): PrivateView {
    session.pendingInput = null;
    session.pendingMassAction = null;
    session.screen = 'home';
    session.lastScreenStack = [];
    return {
      text: 'Посты и автопостинг теперь в Публике.',
      options: {
        buttons: [
          [
            {
              type: 'link',
              text: 'Открыть бота Публик',
              url: `https://max.ru/${this.publisherBotId}`,
            },
          ],
        ],
      },
    };
  }

  private isStaleLegacyCallbackPayload(payload: string | null): boolean {
    if (!payload) {
      return false;
    }

    const normalized = payload.trim().toLowerCase();
    return normalized.startsWith('private_menu:');
  }

  private extractBotStartedStartPayload(update: MaxUpdate): string | null {
    const raw = asPrivateControlRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = asPrivateControlRecord(raw.data);
    const event = asPrivateControlRecord(raw.event);
    const candidates = [
      raw,
      asPrivateControlRecord(raw.bot_started),
      data,
      data ? asPrivateControlRecord(data.bot_started) : null,
      event,
      event ? asPrivateControlRecord(event.bot_started) : null,
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

  private resolveContext(update: MaxUpdate): PrivateContext | null {
    const message = update.message;
    if (!message) {
      return null;
    }

    if (!this.isPrivateDirectChat(message.chatId)) {
      return null;
    }

    const callbackId = this.extractCallbackId(update);
    const callbackPayload = this.extractCallbackPayload(update);
    const actorFromCallback = this.extractCallbackUser(update);

    const actorUserId = actorFromCallback.userId ?? this.normalizeUserId(message.senderId);
    if (!actorUserId) {
      return null;
    }

    if (this.isOwnBotSender(actorUserId)) {
      return null;
    }

    const actor: AuthUser = {
      userId: actorUserId,
      username: null,
      displayName: actorFromCallback.displayName ?? message.senderName ?? null,
      chatId: message.chatId,
      chatTitle: message.chatTitle ?? null,
    };

    return {
      update,
      chatId: message.chatId,
      actor,
      text: typeof message.text === 'string' ? message.text : '',
      callbackId,
      callbackPayload,
    };
  }

  private extractCallbackUser(update: MaxUpdate): {
    userId: string | null;
    displayName: string | null;
  } {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return {
        userId: null,
        displayName: null,
      };
    }

    const user = asPrivateControlRecord(callback.user);
    if (!user) {
      return {
        userId: null,
        displayName: null,
      };
    }

    const userId = this.normalizeUserId(user.user_id ?? user.userId ?? user.id);
    return {
      userId,
      displayName: resolveMaxUserDisplayName(user),
    };
  }

  private extractCallbackNode(update: MaxUpdate): Record<string, unknown> | null {
    const raw = asPrivateControlRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = asPrivateControlRecord(raw.data);
    const event = asPrivateControlRecord(raw.event);
    const candidates = [
      asPrivateControlRecord(raw.callback),
      asPrivateControlRecord(raw.message_callback),
      data ? asPrivateControlRecord(data.callback) : null,
      data ? asPrivateControlRecord(data.message_callback) : null,
      event ? asPrivateControlRecord(event.callback) : null,
      event ? asPrivateControlRecord(event.message_callback) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const nested = asPrivateControlRecord(candidate.callback);
      if (nested) {
        return nested;
      }

      if (
        candidate.callback_id !== undefined ||
        candidate.callbackId !== undefined ||
        candidate.payload !== undefined
      ) {
        return candidate;
      }
    }

    return null;
  }

  private extractCallbackId(update: MaxUpdate): string | null {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return null;
    }

    const value = callback.callback_id ?? callback.callbackId ?? callback.id;
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private extractCallbackPayload(update: MaxUpdate): string | null {
    const callback = this.extractCallbackNode(update);
    if (!callback) {
      return null;
    }

    const value = callback.payload ?? callback.data;
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private resolvePrimaryScreen(_session: PrivateSession): PrivateScreen {
    return 'home';
  }

  private assertChatSelected(
    session: PrivateSession,
  ): asserts session is PrivateSession & { selectedChatId: string } {
    if (!session.selectedChatId) {
      throw new BadRequestException('Сначала выберите чат.');
    }
  }

  private assertSelectedEntityType(
    session: PrivateSession,
    entityType: ManagedEntityType,
  ): asserts session is PrivateSession & {
    selectedChatId: string;
    selectedEntityType: ManagedEntityType;
  } {
    if (!session.selectedChatId) {
      throw new BadRequestException(
        entityType === 'channel' ? 'Сначала выберите канал.' : 'Сначала выберите чат.',
      );
    }

    const selectedEntityType = session.selectedEntityType ?? 'chat';
    if (selectedEntityType !== entityType) {
      throw new BadRequestException(
        entityType === 'channel'
          ? 'Этот раздел доступен только для каналов.'
          : 'Этот раздел доступен только для чатов.',
      );
    }
  }

  private isPrivateDirectChat(chatId: string): boolean {
    return isPrivateDirectChatId(chatId);
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (!value || typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = trimmed.replace(/^id/i, '').replace(/_bot$/i, '').trim();
    return normalized.length > 0 ? normalized : null;
  }

  private buildBotIdVariants(normalizedBotId: string | null): Set<string> {
    const variants = new Set<string>();
    if (!normalizedBotId) {
      return variants;
    }

    variants.add(normalizedBotId);
    variants.add(`id${normalizedBotId}`);
    variants.add(`id${normalizedBotId}_bot`);
    variants.add(`${normalizedBotId}_bot`);

    return variants;
  }

  private normalizeUserId(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private isOwnBotSender(userId: string): boolean {
    if (this.maxBotLinkService?.isKnownBotUserId(userId)) {
      return true;
    }

    if (!userId) {
      return false;
    }

    const normalized = userId.trim();
    if (!normalized) {
      return false;
    }

    if (this.ownBotUserIdVariants.has(normalized)) {
      return true;
    }

    const collapsed = normalized.replace(/^id/i, '').replace(/_bot$/i, '').trim();
    if (!collapsed) {
      return false;
    }

    return this.ownBotUserIdVariants.has(collapsed);
  }

  private getCurrentBotToken(botId?: string | null): string {
    return this.maxBotLinkService?.getBotTokenSync(botId) ?? this.maxBotToken;
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/\/+$/, '');
  }

  protected async loadSession(userId: string): Promise<PrivateSession> {
    return this.sessionStore.loadSession(userId, this.sessionBotContext.currentBotId());
  }

  private async loadSessionForDiagnostics(userId: string): Promise<PrivateSession | null> {
    return this.sessionStore.loadSessionForDiagnostics(
      userId,
      this.sessionBotContext.currentBotId(),
    );
  }

  private async saveSession(userId: string, session: PrivateSession): Promise<void> {
    await this.sessionStore.saveSession(userId, session, this.sessionBotContext.currentBotId());
  }

  private createDefaultSession(): PrivateSession {
    return createDefaultPrivateControlSession();
  }

  private normalizeSession(raw: unknown): PrivateSession {
    return normalizePrivateControlSession(raw, {
      normalizeBroadcastDraft: normalizePrivateBroadcastDraft,
      normalizeSuggestionDraft: normalizePrivateSuggestionDraft,
    });
  }

  private sessionKey(userId: string): string {
    return this.sessionStore.sessionKey(userId, this.sessionBotContext.currentBotId());
  }

  protected runWithUpdateSessionBot<T>(update: MaxUpdate, operation: () => Promise<T>): Promise<T> {
    return this.runWithSessionBot(this.readUpdateBotId(update), operation);
  }

  protected runWithSessionBot<T>(
    botId: string | null | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.sessionBotContext.run(botId, operation);
  }
}
