import { broadcastHandoffResponseSchema, type ManagedEntityType } from '@maxim/contracts';
import { commentAuthorProfileHandoffRequestSchema } from '@maxim/contracts/channel-dialog';
import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherCommentProfileService } from '../publisher/publisher-comment-profile.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import { PUBLISHER_CHAT_DIALOG_ACTION_COMMENT } from './admin.service.support';

@Controller('v1')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublisherCommentAuthorProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dialogLinks: PublisherDialogLinkService,
    private readonly readiness: PublisherReadinessService,
    private readonly profiles: PublisherCommentProfileService,
  ) {}

  @Post('channels/:chatId/dialog/comments/messages/:messageId/profile/handoff')
  handoffChannelAuthor(
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.handoff('channel', chatId, messageId, user.userId, body);
  }

  @Post('chats/:chatId/dialog/comments/messages/:messageId/profile/handoff')
  handoffChatAuthor(
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.handoff('chat', chatId, messageId, user.userId, body);
  }

  private async handoff(
    entityType: ManagedEntityType,
    chatId: string,
    messageId: string,
    actorUserId: string,
    body: unknown,
  ) {
    const parsed = commentAuthorProfileHandoffRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Некорректный запрос на открытие профиля.');
    }
    const { token } = parsed.data;
    const threadId =
      entityType === 'channel'
        ? this.dialogLinks.resolveChannelDialogThreadId(chatId, 'comments', token)
        : this.dialogLinks.resolveChatDialogThreadId(chatId, 'comments', token);
    if (!threadId) {
      throw new BadRequestException('Ссылка на комментарии недействительна.');
    }
    const route = await this.readiness.assertEntityReady(chatId, 'publication');
    if (route.entityType !== entityType) {
      throw new BadRequestException('Ссылка на комментарии недействительна.');
    }

    // FLAG: Authorize the exact Publisher comment in the signed thread before the bot resolves its author.
    // Accepting a user ID from the client would turn a comment link into a profile lookup.
    const comment = await this.prisma.auditLog.findUnique({
      where: {
        id: messageId,
        chatId,
        action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
        payload: { path: ['threadId'], equals: threadId },
      },
      select: { id: true },
    });
    if (!comment) {
      throw new NotFoundException('Комментарий не найден.');
    }
    const botUrl = this.profiles.buildStartUrl({ actorUserId, commentId: comment.id });
    return broadcastHandoffResponseSchema.parse({ botUrl });
  }
}
