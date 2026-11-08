import type {
  ChannelDialogResponse,
  ChannelDialogType,
  ChannelSettings,
  ChatSettings,
  CreateChannelDialogMessageResponse,
  DeleteChannelDialogMessageResponse,
  ManagedEntityType,
  ToggleChannelDialogReactionResponse,
  UpdateChannelDialogMessageResponse,
  UpdateChannelDialogNotificationsResponse,
} from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { AdminChannelSuggestionPublicationRuntime } from './admin-channel-suggestion-publication-runtime';

export const CHANNEL_DIALOG_LEGACY_PORT = Symbol('CHANNEL_DIALOG_LEGACY_PORT');

export type ChannelDialogLegacyPort = {
  readonly channelSuggestionPublicationRuntime: AdminChannelSuggestionPublicationRuntime;
  createChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    dialogProfile?: MiniappProfile,
  ): Promise<CreateChannelDialogMessageResponse>;
  createChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    dialogProfile?: MiniappProfile,
  ): Promise<CreateChannelDialogMessageResponse>;
  deleteChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile?: MiniappProfile,
  ): Promise<DeleteChannelDialogMessageResponse>;
  deleteChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile?: MiniappProfile,
  ): Promise<DeleteChannelDialogMessageResponse>;
  getChannelDialog(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    token: string | null,
    dialogProfile?: MiniappProfile,
  ): Promise<ChannelDialogResponse>;
  getChatDialog(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    token: string | null,
    dialogProfile?: MiniappProfile,
  ): Promise<ChannelDialogResponse>;
  getPublicChannelSettingsForDialog(chatId: string): Promise<ChannelSettings>;
  getPublicPublisherChannelCommentSettingsForDialog(
    chatId: string,
  ): Promise<{ commentsEnabled: boolean }>;
  getPublicChatCommentSettingsForDialog(
    chatId: string,
    token?: string | null,
  ): Promise<Pick<ChatSettings, 'commentsEnabled'>>;
  getPublicPublisherChatCommentSettingsForDialog(
    chatId: string,
  ): Promise<Pick<ChatSettings, 'commentsEnabled'>>;
  processChannelSuggestionDeliveryJob(auditLogId: string): Promise<void>;
  processPublisherSuggestionAdminDeliveryJob(
    auditLogId: string,
    requiredBotId: string,
  ): Promise<void>;
  recordChannelSuggestionDeliveryJobFailure(
    auditLogId: string,
    error: unknown,
    metadata: { final: boolean; attemptsMade: number; maxAttempts: number },
  ): Promise<void>;
  recoverStaleChannelSuggestionDeliveries(limit?: number): Promise<number>;
  syncPublisherSuggestionAdminReviewMessages(
    suggestionId: string,
    requiredBotId: string,
  ): Promise<void>;
  toggleEntityDialogReactionForDialog(params: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    emoji: string;
    dialogProfile?: MiniappProfile;
  }): Promise<ToggleChannelDialogReactionResponse>;
  updateChannelDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile?: MiniappProfile,
  ): Promise<UpdateChannelDialogMessageResponse>;
  updateChannelDialogNotifications(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    dialogProfile?: MiniappProfile,
  ): Promise<UpdateChannelDialogNotificationsResponse>;
  updateChatDialogMessage(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    messageId: string,
    body: unknown,
    dialogProfile?: MiniappProfile,
  ): Promise<UpdateChannelDialogMessageResponse>;
  updateChatDialogNotifications(
    chatId: string,
    user: AuthUser,
    dialogTypeRaw: string,
    body: unknown,
    dialogProfile?: MiniappProfile,
  ): Promise<UpdateChannelDialogNotificationsResponse>;
};
