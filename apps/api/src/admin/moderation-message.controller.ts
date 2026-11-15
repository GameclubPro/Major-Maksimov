import { z } from 'zod';
import { BadRequestException, Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ModerationMessageService } from './moderation-message.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class ModerationMessageController {
  constructor(private readonly messages: ModerationMessageService) {}

  @Get('chats/:chatId/moderation-feed/:eventId/message')
  @Header('Cache-Control', 'private, no-store')
  getMessage(
    @Param('chatId') chatId: unknown,
    @Param('eventId') eventId: unknown,
    @CurrentUser() user: AuthUser,
  ) {
    const params = z
      .object({ chatId: z.string().min(1).max(200), eventId: z.string().min(1).max(200) })
      .safeParse({ chatId, eventId });
    if (!params.success) throw new BadRequestException('Некорректная запись.');
    return this.messages.getMessage(params.data.chatId, params.data.eventId, user);
  }
}
