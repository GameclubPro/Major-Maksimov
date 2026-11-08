import {
  channelDialogTypeSchema,
  toggleChannelDialogReactionRequestSchema,
  type ChannelDialogType,
  type ManagedEntityType,
  type ToggleChannelDialogReactionResponse,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MiniappProfile } from '@maxim/contracts/publisher';

type DialogCommentSettings = {
  commentsEnabled: boolean;
};

export async function toggleDialogReactionValue(params: {
  chatId: string;
  user: AuthUser;
  entityType: ManagedEntityType;
  dialogTypeRaw: string;
  messageId: string;
  body: unknown;
  dialogProfile?: MiniappProfile;
  loadCommentSettings: (chatId: string, token: string) => Promise<DialogCommentSettings>;
  toggleReaction: (options: {
    chatId: string;
    entityType: ManagedEntityType;
    userId: string;
    dialogType: ChannelDialogType;
    messageId: string;
    token: string;
    emoji: string;
    dialogProfile?: MiniappProfile;
  }) => Promise<ToggleChannelDialogReactionResponse>;
}): Promise<ToggleChannelDialogReactionResponse> {
  const dialogType = channelDialogTypeSchema.parse(params.dialogTypeRaw);
  const parsed = toggleChannelDialogReactionRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const settings = await params.loadCommentSettings(params.chatId, parsed.data.token);
  if (!settings.commentsEnabled) {
    throw new BadRequestException(
      params.entityType === 'channel'
        ? 'Комментарии для этого канала сейчас закрыты.'
        : 'Комментарии для этого чата сейчас закрыты.',
    );
  }

  return params.toggleReaction({
    chatId: params.chatId,
    entityType: params.entityType,
    userId: params.user.userId,
    dialogType,
    messageId: params.messageId,
    token: parsed.data.token,
    emoji: parsed.data.emoji,
    ...(params.dialogProfile ? { dialogProfile: params.dialogProfile } : {}),
  });
}
