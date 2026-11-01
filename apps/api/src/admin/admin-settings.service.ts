import { readChatClosureStatus } from './chat-closure-status';
import type { NetworkSettingsWriteOptions } from './network-settings-write';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  channelSettingsScreenResponseSchema,
  chatSettingsScreenResponseSchema,
  publishChatRulesRequestSchema,
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  type ApplySectionTargetPreviewResponse,
  type ApplySectionToAllResponse,
  type ApplySettingsTarget,
  type ChannelPostSignatureSettings,
  type ChannelSettings,
  type ChannelSettingsScreenResponse,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type DuplicatePhotoEffectivePolicy,
  type DuplicatePhotoModerationMode,
  type DuplicatePhotoPolicyMatrix,
  type PublishChannelEngagementResult,
  type PublishChatRulesResult,
  type ResolveRequiredSubscriptionChannelResponse,
} from '@maxim/contracts';
import {
  updateBotSpeechStyleRequestSchema,
  updateBotSpeechStyleResponseSchema,
  type UpdateBotSpeechStyleResponse,
} from '@maxim/contracts/bot-speech';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MiniappAccessObservabilityService } from '../auth/miniapp-access-observability.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatCatalogKind, ChatEntityType } from '../prisma/prisma-client';
import { NightModeTransitionSchedulerService } from '../moderation/night-mode-transition-scheduler.service';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { PhotoDuplicateRuntimePolicyService } from '../moderation/photo-duplicate/photo-duplicate-runtime-policy.service';
import { MessageDuplicatePolicyService } from '../moderation/message-duplicate/message-duplicate-policy.service';
import {
  publishChatRules,
  readChatRules,
  resetPublishedChatRules,
  saveChatRulesDraft,
} from './admin-chat-rules';
import { publishChannelEngagementMessage as publishChannelEngagementMessageValue } from './admin-channel-engagement';
import { readChannelSettings, saveChannelSettings } from './admin-channel-settings';
import {
  isRequiredSubscriptionCurrentlyActive,
  readChatSettingsSnapshot,
  saveChatSettings,
  type ChatSettingsReadSnapshot,
} from './admin-chat-settings';
import { buildRulesTextFromSettings } from './admin-chat-rules-text-format';
import { buildSettingsSectionPatch } from './admin-settings-section-patch';
import { CommercialOcrRuntimePolicyService } from '../moderation/commercial-ocr/commercial-ocr-runtime-policy.service';
import { ConfigService } from '@nestjs/config';
import {
  applySettingsSectionToAllChats as applySettingsSectionToAllChatsValue,
  applySettingsToAllChats as applySettingsToAllChatsValue,
  previewApplySettingsSectionTarget as previewApplySettingsSectionTargetValue,
} from './admin-settings-apply';
import { AdminService } from './admin.service';
import { AdminManualMessageCleanupService } from './admin-manual-message-cleanup.service';
import { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import { sanitizePublicManagedEntityHeader } from './admin-managed-entity-header';
import {
  type AdminActionSource,
  type AdminReadBypassOptions,
  type ApplySettingsToAllChatsResult,
} from './admin.service.support';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { ManualModerationService } from './manual-moderation.service';
import { classifySettingsScreenAccessError } from './settings-screen-access.error';
import { AdminDuplicateDiagnosticsService } from './admin-duplicate-diagnostics.service';
import { ReportViewService } from '../moderation/reports/report-view.service';
import { AdminMessageRetentionService } from './admin-message-retention.service';

const NIGHT_MODE_TRANSITION_SETTING_KEYS = new Set<keyof ChatSettings>([
  'nightModeEnabled',
  'nightModeStartTimeMinutes',
  'nightModeEndTimeMinutes',
  'nightModeTimezone',
]);

@Injectable()
export class AdminSettingsService {
  private readonly logger = new Logger(AdminSettingsService.name);

  constructor(
    private readonly legacyAdminService: AdminService,
    private readonly prisma: PrismaService,
    private readonly chatContextCache: ChatContextCacheService,
    private readonly maxClient: MaxClientService,
    private readonly settingsBotCapabilities: AdminSettingsBotCapabilityService,
    private readonly managedEntitiesService: ManagedEntitiesService,
    private readonly manualModerationService: ManualModerationService,
    private readonly managedBroadcastService: ManagedBroadcastService,
    private readonly photoDuplicateRuntimePolicy: PhotoDuplicateRuntimePolicyService,
    private readonly moderationDeleteIntents: ModerationDeleteIntentService,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
    @Optional()
    private readonly manualMessageCleanupService?: AdminManualMessageCleanupService,
    @Optional()
    private readonly channelPostSignatureService?: ChannelPostSignatureService,
    @Optional()
    private readonly accessObservability?: MiniappAccessObservabilityService,
    @Optional() private readonly messageDuplicatePolicy?: MessageDuplicatePolicyService,
    @Optional() private readonly duplicateDiagnostics?: AdminDuplicateDiagnosticsService,
    @Optional() private readonly reports?: ReportViewService,
    @Optional() private readonly retention?: AdminMessageRetentionService,
    @Optional() _commercialOcrRuntimePolicy?: CommercialOcrRuntimePolicyService,
    @Optional() private readonly botRegistry?: MaxBotRegistryService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async getDuplicateDiagnostics(chatId: string, user: AuthUser, recheck = false, query?: unknown) {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    if (!this.duplicateDiagnostics)
      throw new ServiceUnavailableException('Duplicate diagnostics unavailable');
    return query === undefined
      ? this.duplicateDiagnostics.read(chatId, recheck)
      : this.duplicateDiagnostics.read(chatId, recheck, query);
  }

  async getDuplicateMessageLink(
    chatId: string,
    user: AuthUser,
    intentId: string,
    role: 'target' | 'original',
  ) {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    if (!this.duplicateDiagnostics)
      throw new ServiceUnavailableException('Duplicate diagnostics unavailable');
    return this.duplicateDiagnostics.readMessageLink(chatId, intentId, role);
  }

  async getSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatSettings> {
    return (await this.getSettingsSnapshot(chatId, user, options)).settings;
  }

  private async getSettingsSnapshot(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatSettingsReadSnapshot> {
    await this.assertSensitiveSettingsReadAccess(chatId, user, 'chat', options);
    const botAssignmentData =
      await this.legacyAdminService.resolveChatSettingsReadBotAssignmentData(chatId);
    return readChatSettingsSnapshot({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      logger: this.logger,
      chatId,
      botAssignmentData,
    });
  }

  async getChatSettingsScreen(
    chatId: string,
    user: AuthUser,
    _options: { liveAdminCheck?: boolean } = {},
  ): Promise<ChatSettingsScreenResponse> {
    await this.assertSettingsScreenAccess(() =>
      this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat'),
    );

    const [settingsSnapshot, rules, headerBundle, domains, messageRetention] = await Promise.all([
      this.getSettingsSnapshot(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.getRules(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.managedEntitiesService.getChatHeaderWithBotSpeechPreviewProfile(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
      this.manualModerationService.getDomainAllowlistDetails(chatId, user, {
        skipAdminCheck: true,
      }),
      this.retention?.summary(chatId).catch(() => {
        this.logger.warn('Message retention summary unavailable');
        return undefined;
      }),
    ]);
    const { settings, stopWordsStorageStatus } = settingsSnapshot;
    const [requiredSubscriptionChannels, duplicatePhotoPolicyMatrix] = await Promise.all([
      this.legacyAdminService.resolveRequiredSubscriptionChannelHeadersForSettings(
        settings.requiredSubscriptionChannelIds,
      ),
      this.resolveDuplicatePhotoPolicyMatrix(chatId),
    ]);
    const duplicatePhotoPolicy =
      settings.duplicatePhotoMatchPreset === 'SAME_IMAGE' &&
      settings.duplicatePhotoScope === 'SAME_AUTHOR'
        ? duplicatePhotoPolicyMatrix.base
        : duplicatePhotoPolicyMatrix.advanced;
    const messagePolicy = await this.messageDuplicatePolicy?.resolve(chatId);
    const duplicateMessageModerationMode =
      !messagePolicy || messagePolicy.mode === 'off'
        ? 'OFF'
        : messagePolicy.mode === 'delete_only' || messagePolicy.mode === 'full'
          ? messagePolicy.mode === 'full'
            ? 'FULL'
            : 'DELETE_ONLY'
          : 'OBSERVE';

    return chatSettingsScreenResponseSchema.parse({
      ...(messageRetention ? { messageRetention } : {}),
      closure: this.botRegistry
        ? await readChatClosureStatus(
            this.prisma,
            chatId,
            settings,
            this.botRegistry.getActionableBots().map((bot) => bot.id),
          ).catch(() => undefined)
        : undefined,
      settings,
      stopWordsStorageStatus,
      // FLAG: Retain the response field for older clients; the commercial filter is text-only.
      commercialPhotoModerationMode: 'OFF',
      commercialAiModerationMode: this.commercialAiModerationMode(),
      reportsAvailable: this.reports?.available(chatId) ?? false,
      duplicatePhotoModerationMode: duplicatePhotoPolicy.moderationMode,
      duplicateMessageModerationMode,
      duplicatePhotoPolicyMatrix,
      rules,
      header: headerBundle.header,
      botSpeechPreviewProfile: headerBundle.botSpeechPreviewProfile,
      requiredSubscriptionChannels: requiredSubscriptionChannels.map((channel) =>
        sanitizePublicManagedEntityHeader(channel),
      ),
      domains,
      managedBroadcasts: [],
    });
  }

  resolveRequiredSubscriptionChannelReference(value: string) {
    return this.legacyAdminService.resolveRequiredSubscriptionChannelReferenceValue(value);
  }

  commercialAiModerationMode(): 'OFF' | 'OBSERVE' | 'DELETE_ONLY' {
    return this.config?.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED') === true
      ? 'DELETE_ONLY'
      : this.config?.get<boolean>('COMMERCIAL_LLM_SHADOW_ENABLED') === true
        ? 'OBSERVE'
        : 'OFF';
  }

  resolveLocalChatUserProfiles(chatId: string, userIds: readonly string[]) {
    return this.legacyAdminService.resolveUserProfilesForAdminSurface(chatId, 'chat', userIds, {
      allowRemoteLookup: false,
    });
  }

  async resolveRequiredSubscriptionChannel(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ResolveRequiredSubscriptionChannelResponse> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    const parsed = resolveRequiredSubscriptionChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channel = sanitizePublicManagedEntityHeader(
      await this.legacyAdminService.resolveRequiredSubscriptionChannelReferenceValue(
        parsed.data.value,
      ),
    );
    return resolveRequiredSubscriptionChannelResponseSchema.parse({ channel });
  }

  async updateSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    options: {
      forceLiveBotCapabilityCheck?: boolean;
      networkWrite?: NetworkSettingsWriteOptions;
    } = {},
  ): Promise<ChatSettings> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    const shouldReconcileNightModeTransitions =
      this.shouldReconcileNightModeTransitionsAfterUpdate(body);
    const settings = await saveChatSettings({
      commercialAiDeleteOnly: this.commercialAiModerationMode() === 'DELETE_ONLY',
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
      networkWrite: options.networkWrite,
      resolveBotAssignmentData: () =>
        this.legacyAdminService.resolveChatSettingsWriteBotAssignmentData(chatId),
      assertRequiredSubscriptionSettings: (settings) =>
        this.legacyAdminService.assertRequiredSubscriptionSettingsForChatSettings(settings),
      reportsAvailable: (id) => this.reports?.available(id) ?? false,
      assertBotCapabilities: (requirements) =>
        options.forceLiveBotCapabilityCheck
          ? this.settingsBotCapabilities.assertChatSettingsBotCapabilities(chatId, requirements, {
              forceLive: true,
            })
          : this.settingsBotCapabilities.assertChatSettingsBotCapabilities(chatId, requirements),
      refreshExecutionReadiness: (settings) =>
        this.legacyAdminService.refreshChatSettingsExecutionReadiness(chatId, settings),
    });
    if (
      shouldReconcileNightModeTransitions &&
      !options.networkWrite?.validateOnly &&
      !options.networkWrite?.deferFollowup
    ) {
      await this.reconcileNightModeTransitions([chatId]);
    }
    return settings;
  }

  async patchSettingsSection(
    chatId: string,
    user: AuthUser,
    body: unknown,
    options: { forceLiveBotCapabilityCheck?: boolean } = {},
  ): Promise<ChatSettings> {
    const current = await this.getSettings(chatId, user);
    return this.updateSettings(
      chatId,
      user,
      buildSettingsSectionPatch(current, body),
      'miniapp',
      options,
    );
  }

  async updateBotSpeechStyle(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<UpdateBotSpeechStyleResponse> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    const parsed = updateBotSpeechStyleRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const botAssignmentData =
      await this.legacyAdminService.resolveChatSettingsWriteBotAssignmentData(chatId);
    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.chat.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          title: `Chat ${chatId}`,
          entityType: ChatEntityType.CHAT,
          catalogKind: ChatCatalogKind.MANAGED,
          ...botAssignmentData,
        },
        update: { catalogKind: ChatCatalogKind.MANAGED },
      });
      // FLAG: Style changes never write editable copy or media, including concurrent custom edits.
      const settings = await tx.chatSettings.upsert({
        where: { chatId },
        create: { chatId, botSpeechStyle: parsed.data.botSpeechStyle },
        update: { botSpeechStyle: parsed.data.botSpeechStyle },
        select: { botSpeechStyle: true, updatedAt: true },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'UPDATE_SETTINGS',
          payload: { source, settingKeys: ['botSpeechStyle'] },
        },
      });
      return updateBotSpeechStyleResponseSchema.parse({
        botSpeechStyle: settings.botSpeechStyle,
        settingsRevision: settings.updatedAt.toISOString(),
      });
    });
    await this.chatContextCache.invalidate(chatId);
    return saved;
  }

  async getRules(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChatRules> {
    await this.assertSensitiveSettingsReadAccess(chatId, user, 'chat', options);
    return readChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      resolveBotId: async () =>
        (await this.legacyAdminService.resolveChatSettingsReadBotAssignmentData(chatId)).botId,
    });
  }

  async updateRules(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return saveChatRulesDraft({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
    });
  }

  async publishRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
    body?: unknown,
  ): Promise<PublishChatRulesResult> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    const request = publishChatRulesRequestSchema.safeParse(body ?? {});
    if (!request.success) throw new BadRequestException(request.error.format());
    return publishChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      actorUserId: user.userId,
      source,
      mode: request.data.mode,
      resolveBotId: () => this.legacyAdminService.resolveChatRulesActionBotId(chatId),
      buildAutofilledText: () => this.buildAutofilledRulesText(chatId, user),
      buildFormattedText: (sourceText, options) =>
        this.legacyAdminService.buildFormattedChatRulesPublicationText(chatId, sourceText, options),
      sendPrivateConfirmation: (publishedUrl, operation) =>
        this.legacyAdminService.sendPublishedChatRulesPrivateConfirmation(
          user,
          publishedUrl,
          operation,
        ),
      ...(this.manualMessageCleanupService
        ? {
            deletePreviousPublishedMessage: (cleanup) =>
              this.manualMessageCleanupService!.deleteChatRulesMessage({
                ...cleanup,
                source,
                actorUserId: user.userId,
              }),
          }
        : {}),
    });
  }

  private async resolveDuplicatePhotoModerationMode(
    chatId: string,
    settings: Pick<ChatSettings, 'duplicatePhotoMatchPreset' | 'duplicatePhotoScope'>,
  ): Promise<DuplicatePhotoModerationMode> {
    return (
      await this.resolveDuplicatePhotoEffectivePolicy(
        chatId,
        settings.duplicatePhotoMatchPreset,
        settings.duplicatePhotoScope,
      )
    ).moderationMode;
  }

  private async resolveDuplicatePhotoPolicyMatrix(
    chatId: string,
  ): Promise<DuplicatePhotoPolicyMatrix> {
    const [base, advanced] = await Promise.all([
      this.resolveDuplicatePhotoEffectivePolicy(chatId, 'SAME_IMAGE', 'SAME_AUTHOR'),
      this.resolveDuplicatePhotoEffectivePolicy(chatId, 'MINOR_EDITS', 'CHAT'),
    ]);
    return { base, advanced };
  }

  private async resolveDuplicatePhotoEffectivePolicy(
    chatId: string,
    _preset: ChatSettings['duplicatePhotoMatchPreset'],
    _scope: ChatSettings['duplicatePhotoScope'],
  ): Promise<DuplicatePhotoEffectivePolicy> {
    const policy = await this.messageDuplicatePolicy?.resolve(chatId);
    return {
      moderationMode:
        policy?.mode === 'full' ? 'FULL' : policy?.mode === 'shadow' ? 'OBSERVE' : 'OFF',
      actionCeiling: 'BAN',
      allowedMatchKinds: ['canonical_sha256'],
    };
  }

  private async buildAutofilledRulesText(chatId: string, user: AuthUser): Promise<string> {
    const settings = await this.getSettings(chatId, user, {
      skipAdminCheck: true,
      skipEntityCheck: true,
    });
    const [domains, requiredSubscriptionChannels, duplicatePhotoModerationMode] = await Promise.all(
      [
        settings.linkPolicy === 'ALLOWLIST_ONLY'
          ? this.manualModerationService.getDomainAllowlistDetails(chatId, user, {
              skipAdminCheck: true,
            })
          : Promise.resolve([]),
        isRequiredSubscriptionCurrentlyActive(settings)
          ? this.legacyAdminService.resolveRequiredSubscriptionChannelHeadersForSettings(
              settings.requiredSubscriptionChannelIds,
            )
          : Promise.resolve([]),
        this.resolveDuplicatePhotoModerationMode(chatId, settings),
      ],
    );

    return buildRulesTextFromSettings({
      settings,
      domains,
      requiredSubscriptionChannels,
      duplicatePhotoModerationMode,
    });
  }

  async buildNetworkRulesText(chatId: string, user: AuthUser): Promise<string> {
    return this.buildAutofilledRulesText(chatId, user);
  }

  async resetPublishedRules(
    chatId: string,
    user: AuthUser,
    source: AdminActionSource = 'miniapp',
  ): Promise<ChatRules> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'chat');
    return resetPublishedChatRules({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      maxClient: this.maxClient,
      logger: this.logger,
      chatId,
      actorUserId: user.userId,
      source,
      resolveBotId: () => this.legacyAdminService.resolveChatRulesActionBotId(chatId),
      ...(this.manualMessageCleanupService
        ? {
            deletePublishedMessage: (cleanup) =>
              this.manualMessageCleanupService!.deleteChatRulesMessage({
                ...cleanup,
                source,
                actorUserId: user.userId,
              }),
          }
        : {}),
    });
  }

  async getChannelSettings(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ChannelSettings> {
    await this.assertSensitiveSettingsReadAccess(chatId, user, 'channel', options);
    const botAssignmentData =
      await this.legacyAdminService.resolveChannelSettingsReadBotAssignmentData(chatId);
    return readChannelSettings({
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
    await this.assertSettingsScreenAccess(() =>
      this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel'),
    );

    const [settings, postSignature, header] = await Promise.all([
      this.getChannelSettings(chatId, user, { skipAdminCheck: true, skipEntityCheck: true }),
      this.channelPostSignatureService?.getSettings(chatId) ??
        Promise.resolve({ enabled: false, text: CHANNEL_POST_SIGNATURE_DEFAULT_TEXT, url: '' }),
      this.managedEntitiesService.getChannelHeader(chatId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      }),
    ]);

    return channelSettingsScreenResponseSchema.parse({
      settings,
      postSignature,
      header,
      managedBroadcasts: [],
    });
  }

  async updateChannelSettings(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
    networkWrite?: NetworkSettingsWriteOptions,
  ): Promise<ChannelSettings> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return saveChannelSettings({
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      chatId,
      actorUserId: user.userId,
      body,
      source,
      networkWrite,
      resolveBotAssignmentData: () =>
        this.legacyAdminService.resolveChannelSettingsWriteBotAssignmentData(chatId),
      refreshExecutionReadiness: () =>
        this.legacyAdminService.refreshChannelSettingsExecutionReadiness(chatId),
    });
  }

  async updateNetworkChatSettings(
    chatId: string,
    user: AuthUser,
    body: ChatSettings,
    networkWrite: NetworkSettingsWriteOptions,
  ): Promise<ChatSettings> {
    return this.updateSettings(chatId, user, body, 'miniapp', {
      forceLiveBotCapabilityCheck: true,
      networkWrite,
    });
  }

  async updateNetworkChannelSettings(
    chatId: string,
    user: AuthUser,
    body: ChannelSettings,
    changedPaths: readonly string[],
    networkWrite: NetworkSettingsWriteOptions,
  ): Promise<ChannelSettings> {
    return this.updateChannelSettings(chatId, user, body, 'miniapp', {
      ...networkWrite,
      authoredChannelKeys: changedPaths as Array<keyof ChannelSettings>,
    });
  }

  async finishNetworkSettingsFollowup(
    chatId: string,
    entityType: 'chat' | 'channel',
    section: string,
  ): Promise<void> {
    await this.chatContextCache.invalidate(chatId);
    if (entityType === 'channel') {
      await this.legacyAdminService.refreshChannelSettingsExecutionReadiness(chatId);
      return;
    }
    const user: AuthUser = {
      userId: 'network-settings-followup',
      username: null,
      displayName: null,
    };
    const settings = await this.getSettings(chatId, user, {
      skipAdminCheck: true,
      skipEntityCheck: true,
    });
    await this.legacyAdminService.refreshChatSettingsExecutionReadiness(chatId, settings);
    if (section === 'night') await this.reconcileNightModeTransitions([chatId]);
  }

  private async assertSettingsScreenAccess(check: () => Promise<void>): Promise<void> {
    try {
      await check();
    } catch (error: unknown) {
      const classified = classifySettingsScreenAccessError(error);
      if (!classified) {
        throw error;
      }

      this.accessObservability?.recordRejection(classified.metric);
      throw classified.exception;
    }
  }

  private async assertSensitiveSettingsReadAccess(
    chatId: string,
    user: AuthUser,
    entityType: 'chat' | 'channel',
    options: AdminReadBypassOptions,
  ): Promise<void> {
    if (options.skipAdminCheck) {
      await this.legacyAdminService.assertManagedEntityReadAccess(
        chatId,
        user.userId,
        entityType,
        options,
      );
      return;
    }

    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
  }

  async getChannelPostSignature(
    chatId: string,
    user: AuthUser,
  ): Promise<ChannelPostSignatureSettings> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    if (!this.channelPostSignatureService) {
      throw new ServiceUnavailableException('Настройки подписи публикаций недоступны.');
    }
    return this.channelPostSignatureService.getSettings(chatId);
  }

  async updateChannelPostSignature(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ChannelPostSignatureSettings> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    if (!this.channelPostSignatureService) {
      throw new ServiceUnavailableException('Настройки подписи публикаций недоступны.');
    }
    return this.channelPostSignatureService.updateSettings(chatId, user.userId, body);
  }

  async publishChannelEngagementMessage(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<PublishChannelEngagementResult> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    const channelPostSignatureService = this.channelPostSignatureService;
    return publishChannelEngagementMessageValue({
      prisma: this.prisma,
      maxClient: this.maxClient,
      chatId,
      actorUserId: user.userId,
      body,
      resolveBotId: () => this.legacyAdminService.resolveChannelEngagementActionBotId(chatId),
      resolveEditBotId: () => this.legacyAdminService.resolveChannelEngagementEditBotId(chatId),
      buildDialogArtifacts: (params) =>
        this.legacyAdminService.buildChannelEngagementDialogArtifacts(params),
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
    confirmedTargetChatIds?: readonly string[],
    expectedSourceSettingsRevision?: string,
  ): Promise<ApplySettingsToAllChatsResult> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(sourceChatId, user.userId, 'chat');
    const shouldReconcileNightModeTransitions = this.shouldReconcileNightModeTransitionsAfterApply(
      targetOrSettingKeys,
      settingKeys,
    );
    const result = await applySettingsToAllChatsValue({
      commercialAiDeleteOnly: this.commercialAiModerationMode() === 'DELETE_ONLY',
      prisma: this.prisma,
      chatContextCache: this.chatContextCache,
      sourceChatId,
      actorUserId: user.userId,
      body,
      source,
      targetOrSettingKeys,
      settingKeys,
      botSpeechMediaKeys,
      confirmedTargetChatIds,
      expectedSourceSettingsRevision,
      normalizeSettings: (settings) =>
        this.legacyAdminService.normalizeChatSettingsForApply(sourceChatId, settings),
      resolveTargetChats: (target) =>
        this.legacyAdminService.resolveSettingsApplyTargetChatsForSettings(
          sourceChatId,
          user,
          target,
        ),
      resolveBotAssignmentData: (chatId) =>
        this.legacyAdminService.resolveSettingsApplyBotAssignmentData(chatId),
      assertRequiredSubscriptionSettings: (settings) =>
        this.legacyAdminService.assertRequiredSubscriptionSettingsForChatSettings(settings),
      reportsAvailable: (id) => this.reports?.available(id) ?? false,
      assertBotCapabilities: (chatId, requirements) =>
        this.settingsBotCapabilities.assertChatSettingsBotCapabilities(chatId, requirements),
      recordConcurrentWriteConflict: (params) =>
        this.logger.warn(params, 'Bulk chat settings write stopped after a revision conflict'),
      onPartialApplied: (chatIds) =>
        shouldReconcileNightModeTransitions
          ? this.reconcileNightModeTransitions(chatIds)
          : Promise.resolve(),
      isRequiredSubscriptionCurrentlyActive: (settings) =>
        this.legacyAdminService.isRequiredSubscriptionCurrentlyActiveForSettings(settings),
      scheduleReadinessRefresh: (params) =>
        this.legacyAdminService.scheduleApplySettingsToAllReadinessRefreshForSettings(params),
      getCurrentSourceSettings: () => this.getSettings(sourceChatId, user),
    });
    if (shouldReconcileNightModeTransitions) {
      await this.reconcileNightModeTransitions(result.appliedChatIds);
    }
    return result;
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
      getSourceStopWordsSettings: () => this.getSettingsSnapshot(sourceChatId, user),
      applySettings: (
        settings,
        target,
        settingKeys,
        botSpeechMediaKeys,
        confirmedTargetChatIds,
        expectedSourceSettingsRevision,
      ) =>
        this.applySettingsToAllChats(
          sourceChatId,
          user,
          settings,
          source,
          target,
          settingKeys,
          botSpeechMediaKeys,
          confirmedTargetChatIds,
          expectedSourceSettingsRevision,
        ),
      syncDomainAllowlistToChats: (targetChatIds) =>
        this.legacyAdminService.syncDomainAllowlistToChatsForSettings(sourceChatId, targetChatIds),
    });
  }

  async previewApplySettingsSectionTarget(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ApplySectionTargetPreviewResponse> {
    await this.legacyAdminService.assertManagedEntityAdminAccess(sourceChatId, user.userId, 'chat');
    return previewApplySettingsSectionTargetValue({
      sourceChatId,
      body,
      resolveTargetChats: (target) =>
        this.legacyAdminService.resolveSettingsApplyTargetChatsForSettings(
          sourceChatId,
          user,
          target,
        ),
    });
  }

  private shouldReconcileNightModeTransitionsAfterApply(
    targetOrSettingKeys: ApplySettingsTarget | readonly (keyof ChatSettings)[],
    settingKeys?: readonly (keyof ChatSettings)[],
  ): boolean {
    const effectiveSettingKeys = Array.isArray(targetOrSettingKeys)
      ? targetOrSettingKeys
      : settingKeys;
    if (!Array.isArray(effectiveSettingKeys) || effectiveSettingKeys.length === 0) {
      return true;
    }

    return effectiveSettingKeys.some((key) => NIGHT_MODE_TRANSITION_SETTING_KEYS.has(key));
  }

  private shouldReconcileNightModeTransitionsAfterUpdate(body: unknown): boolean {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return false;
    }

    return Object.keys(body).some((key) =>
      NIGHT_MODE_TRANSITION_SETTING_KEYS.has(key as keyof ChatSettings),
    );
  }

  private reconcileNightModeTransitions(chatIds: readonly string[]): Promise<void> {
    // FLAG: Night-mode settings writes enqueue a generation-fenced SQL request in the same DB
    // transaction. This non-blocking call is only the fast path; the enqueue-role poller owns
    // durable retry and keeps Redis lock contention out of the committed admin request latency.
    void this.nightModeTransitionScheduler?.reconcileChats([...chatIds]).catch((error: unknown) => {
      this.logger.warn(
        {
          chatIds,
          error: error instanceof Error ? error.message : String(error),
        },
        'Deferred night mode transition jobs to durable reconciliation after settings update',
      );
    });
    return Promise.resolve();
  }
}
