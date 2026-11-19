import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { ManagedGiveawayService } from './managed-giveaway.service';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminGiveawayController {
  constructor(private readonly managedGiveawayService: ManagedGiveawayService) {}

  @Get('chats/:chatId/giveaways')
  getChatGiveaways(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.listManagedGiveaways(chatId, user, 'chat');
  }

  @Post('chats/:chatId/giveaways')
  createChatGiveaway(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.createManagedGiveaway(chatId, user, body, 'chat');
  }

  @Post('chats/:chatId/giveaways/required-channels/resolve')
  resolveChatGiveawayRequiredChannel(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.resolveManagedGiveawayRequiredChannel(
      chatId,
      user,
      body,
      'chat',
    );
  }

  @Get('chats/:chatId/giveaways/:giveawayId')
  getChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.getManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Put('chats/:chatId/giveaways/:giveawayId')
  updateChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.updateManagedGiveaway(
      chatId,
      giveawayId,
      user,
      body,
      'chat',
    );
  }

  @Post('chats/:chatId/giveaways/:giveawayId/publish')
  publishChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.publishManagedGiveaway(
      chatId,
      giveawayId,
      user,
      'chat',
      'miniapp',
      body,
    );
  }

  @Post('chats/:chatId/giveaways/:giveawayId/close')
  closeChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.closeManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Post('chats/:chatId/giveaways/:giveawayId/refresh-publication')
  refreshChatGiveawayPublication(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.refreshManagedGiveawayPublication(
      chatId,
      giveawayId,
      user,
      'chat',
    );
  }

  @Post('chats/:chatId/giveaways/:giveawayId/reroll')
  rerollChatGiveawayWinner(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.rerollManagedGiveawayWinner(
      chatId,
      giveawayId,
      user,
      body,
      'chat',
    );
  }

  @Post('chats/:chatId/giveaways/:giveawayId/deliver')
  deliverChatGiveawayWinner(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.markManagedGiveawayWinnerDelivered(
      chatId,
      giveawayId,
      user,
      body,
      'chat',
    );
  }

  @Post('chats/:chatId/giveaways/:giveawayId/cancel')
  cancelChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.cancelManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Delete('chats/:chatId/giveaways/:giveawayId')
  deleteChatGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.deleteManagedGiveaway(chatId, giveawayId, user, 'chat');
  }

  @Get('channels/:chatId/giveaways')
  getChannelGiveaways(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.listManagedGiveaways(chatId, user, 'channel');
  }

  @Post('channels/:chatId/giveaways')
  createChannelGiveaway(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.createManagedGiveaway(chatId, user, body, 'channel');
  }

  @Post('channels/:chatId/giveaways/required-channels/resolve')
  resolveChannelGiveawayRequiredChannel(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.resolveManagedGiveawayRequiredChannel(
      chatId,
      user,
      body,
      'channel',
    );
  }

  @Get('channels/:chatId/giveaways/:giveawayId')
  getChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.getManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Put('channels/:chatId/giveaways/:giveawayId')
  updateChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.updateManagedGiveaway(
      chatId,
      giveawayId,
      user,
      body,
      'channel',
    );
  }

  @Post('channels/:chatId/giveaways/:giveawayId/publish')
  publishChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.publishManagedGiveaway(
      chatId,
      giveawayId,
      user,
      'channel',
      'miniapp',
      body,
    );
  }

  @Post('channels/:chatId/giveaways/:giveawayId/close')
  closeChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.closeManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Post('channels/:chatId/giveaways/:giveawayId/refresh-publication')
  refreshChannelGiveawayPublication(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.refreshManagedGiveawayPublication(
      chatId,
      giveawayId,
      user,
      'channel',
    );
  }

  @Post('channels/:chatId/giveaways/:giveawayId/reroll')
  rerollChannelGiveawayWinner(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.rerollManagedGiveawayWinner(
      chatId,
      giveawayId,
      user,
      body,
      'channel',
    );
  }

  @Post('channels/:chatId/giveaways/:giveawayId/deliver')
  deliverChannelGiveawayWinner(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.managedGiveawayService.markManagedGiveawayWinnerDelivered(
      chatId,
      giveawayId,
      user,
      body,
      'channel',
    );
  }

  @Post('channels/:chatId/giveaways/:giveawayId/cancel')
  cancelChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.cancelManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Delete('channels/:chatId/giveaways/:giveawayId')
  deleteChannelGiveaway(
    @Param('chatId') chatId: string,
    @Param('giveawayId') giveawayId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.managedGiveawayService.deleteManagedGiveaway(chatId, giveawayId, user, 'channel');
  }

  @Get('giveaways/:giveawayId')
  getGiveaway(@Param('giveawayId') giveawayId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.getPublicGiveaway(giveawayId, user);
  }

  @Get('giveaways/:giveawayId/me')
  getGiveawayMe(@Param('giveawayId') giveawayId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.getGiveawayParticipantState(giveawayId, user);
  }

  @Post('giveaways/:giveawayId/enter')
  enterGiveaway(@Param('giveawayId') giveawayId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.enterGiveaway(giveawayId, user);
  }

  @Post('giveaways/:giveawayId/claim')
  claimGiveaway(@Param('giveawayId') giveawayId: string, @CurrentUser() user: AuthUser) {
    return this.managedGiveawayService.claimGiveaway(giveawayId, user);
  }
}
