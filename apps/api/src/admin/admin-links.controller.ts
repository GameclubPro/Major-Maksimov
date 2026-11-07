import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminLinksService } from './admin-links.service';

@Controller('v1/chats/:chatId/links')
@UseGuards(InitDataGuard)
export class AdminLinksController {
  constructor(private readonly service: AdminLinksService) {}

  @Post('preview')
  preview(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.service.preview(chatId, user, body);
  }
}
