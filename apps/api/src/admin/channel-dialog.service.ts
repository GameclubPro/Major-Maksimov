import { PrismaService } from '../prisma/prisma.service';
import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import type { ManagedEntityType } from '@maxim/contracts';
import {
  normalizeAppBaseUrl,
  normalizeBotContactId,
  normalizeOwnBotUserId,
} from './admin-legacy-utils';
import { toggleDialogReactionValue } from './admin-channel-dialog-reaction';
import { getChannelSuggestionRedirectValue } from './admin-channel-dialog-redirect';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import {
  CHANNEL_DIALOG_LEGACY_PORT,
  type ChannelDialogLegacyPort,
} from './channel-dialog-legacy.port';

@Injectable()
export class ChannelDialogService {
  private readonly dialogLinkHelper: AdminDialogLinkHelper;

  constructor(
    @Inject(CHANNEL_DIALOG_LEGACY_PORT)
    private readonly legacyAdminService: ChannelDialogLegacyPort,
    configService: ConfigService,
    private readonly prisma: PrismaService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly publisherDialogLinks?: PublisherDialogLinkService,
  ) {
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    const maxBotToken =
      this.maxBotLinkService?.getBotTokenSync?.() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    const maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens?.() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [maxBotToken]);
    this.dialogLinkHelper = new AdminDialogLinkHelper({
      appBaseUrl: normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL')),
      explicitBotContactId: normalizeBotContactId(configService.get<string>('MAX_BOT_CONTACT_ID')),
      ownBotUserId: normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID')),
      maxBotToken,
      maxBotTokenValidationSecrets,
      maxBotLinkService: this.maxBotLinkService,
      maxBotRegistry: this.maxBotRegistry,
    });
  }

  resolveCommentThread(
    chatId: string,
    entityType: ManagedEntityType,
    token: string,
    profile: MiniappProfile,
  ): string | null {
    const links = profile === 'publisher' ? this.publisherDialogLinks : this.dialogLinkHelper;
    if (!links) throw new ServiceUnavailableException('Комментарии временно недоступны.');
    const threadId =
      entityType === 'channel'
        ? links.resolveChannelDialogThreadId(chatId, 'comments', token)
        : links.resolveChatDialogThreadId(chatId, 'comments', token);
    if (profile === 'publisher' && !threadId)
      throw new BadRequestException('Ссылка на комментарии недействительна.');
    return threadId;
  }

  getChannelSuggestionRedirect(chatId: string, token: string | null) {
    return getChannelSuggestionRedirectValue({
      chatId,
      token,
      dialogLinkHelper: this.dialogLinkHelper,
      loadChannelSettings: (channelId) =>
        this.legacyAdminService.getPublicChannelSettingsForDialog(channelId),
      resolveBotId: (channelId) =>
        this.maxBotLinkService?.getStoredChatPrimaryBotId(channelId) ?? Promise.resolve(null),
    });
  }

  async getChannelDialog(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    token: string | null,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['getChannelDialog']> {
    const dialog = await this.legacyAdminService.getChannelDialog(
      chatId,
      user,
      dialogType,
      token,
      profile,
    );
    if (dialog.type !== 'suggest') return dialog;
    const channel = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { title: true },
    });
    return { ...dialog, entityTitle: channel?.title.trim() || null };
  }

  createChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['createChannelDialogMessage']> {
    return this.legacyAdminService.createChannelDialogMessage(
      chatId,
      user,
      dialogType,
      body,
      profile,
    );
  }

  updateChannelDialogNotifications(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['updateChannelDialogNotifications']> {
    return this.legacyAdminService.updateChannelDialogNotifications(
      chatId,
      user,
      dialogType,
      body,
      profile,
    );
  }

  updateChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    messageId: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['updateChannelDialogMessage']> {
    return this.legacyAdminService.updateChannelDialogMessage(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  deleteChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    messageId: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['deleteChannelDialogMessage']> {
    return this.legacyAdminService.deleteChannelDialogMessage(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  toggleChannelDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['toggleEntityDialogReactionForDialog']> {
    return toggleDialogReactionValue({
      chatId,
      user,
      entityType: 'channel',
      dialogTypeRaw,
      messageId,
      body,
      dialogProfile: profile,
      loadCommentSettings: (channelId) =>
        profile === 'publisher'
          ? this.legacyAdminService.getPublicPublisherChannelCommentSettingsForDialog(channelId)
          : this.legacyAdminService.getPublicChannelSettingsForDialog(channelId),
      toggleReaction: (options) =>
        this.legacyAdminService.toggleEntityDialogReactionForDialog(options),
    });
  }

  getChatDialog(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    token: string | null,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['getChatDialog']> {
    return this.legacyAdminService.getChatDialog(chatId, user, dialogType, token, profile);
  }

  createChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['createChatDialogMessage']> {
    return this.legacyAdminService.createChatDialogMessage(chatId, user, dialogType, body, profile);
  }

  updateChatDialogNotifications(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['updateChatDialogNotifications']> {
    return this.legacyAdminService.updateChatDialogNotifications(
      chatId,
      user,
      dialogType,
      body,
      profile,
    );
  }

  updateChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    messageId: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['updateChatDialogMessage']> {
    return this.legacyAdminService.updateChatDialogMessage(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  deleteChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogType: string,
    messageId: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['deleteChatDialogMessage']> {
    return this.legacyAdminService.deleteChatDialogMessage(
      chatId,
      user,
      dialogType,
      messageId,
      body,
      profile,
    );
  }

  toggleChatDialogReaction(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    profile: MiniappProfile = 'moderation',
  ): ReturnType<ChannelDialogLegacyPort['toggleEntityDialogReactionForDialog']> {
    return toggleDialogReactionValue({
      chatId,
      user,
      entityType: 'chat',
      dialogTypeRaw,
      messageId,
      body,
      dialogProfile: profile,
      loadCommentSettings: (chatId, token) =>
        profile === 'publisher'
          ? this.legacyAdminService.getPublicPublisherChatCommentSettingsForDialog(chatId)
          : this.legacyAdminService.getPublicChatCommentSettingsForDialog(chatId, token),
      toggleReaction: (options) =>
        this.legacyAdminService.toggleEntityDialogReactionForDialog(options),
    });
  }

  processChannelSuggestionDeliveryJob(
    ...args: Parameters<ChannelDialogLegacyPort['processChannelSuggestionDeliveryJob']>
  ): ReturnType<ChannelDialogLegacyPort['processChannelSuggestionDeliveryJob']> {
    return this.legacyAdminService.processChannelSuggestionDeliveryJob(...args);
  }

  processPublisherSuggestionAdminDeliveryJob(
    ...args: Parameters<ChannelDialogLegacyPort['processPublisherSuggestionAdminDeliveryJob']>
  ): ReturnType<ChannelDialogLegacyPort['processPublisherSuggestionAdminDeliveryJob']> {
    return this.legacyAdminService.processPublisherSuggestionAdminDeliveryJob(...args);
  }

  processPublisherSuggestionPublicationJob(
    suggestionId: string,
    claimToken: string,
  ): Promise<void> {
    return this.legacyAdminService.channelSuggestionPublicationRuntime.processPublisherSuggestionPublicationJob(
      suggestionId,
      claimToken,
    );
  }

  recoverStaleChannelSuggestionDeliveries(
    ...args: Parameters<ChannelDialogLegacyPort['recoverStaleChannelSuggestionDeliveries']>
  ): ReturnType<ChannelDialogLegacyPort['recoverStaleChannelSuggestionDeliveries']> {
    return this.legacyAdminService.recoverStaleChannelSuggestionDeliveries(...args);
  }

  syncPublisherSuggestionAdminReviewMessages(
    ...args: Parameters<ChannelDialogLegacyPort['syncPublisherSuggestionAdminReviewMessages']>
  ): ReturnType<ChannelDialogLegacyPort['syncPublisherSuggestionAdminReviewMessages']> {
    return this.legacyAdminService.syncPublisherSuggestionAdminReviewMessages(...args);
  }

  recordChannelSuggestionDeliveryJobFailure(
    ...args: Parameters<ChannelDialogLegacyPort['recordChannelSuggestionDeliveryJobFailure']>
  ): ReturnType<ChannelDialogLegacyPort['recordChannelSuggestionDeliveryJobFailure']> {
    return this.legacyAdminService.recordChannelSuggestionDeliveryJobFailure(...args);
  }
}
