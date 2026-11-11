import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { wasMaxMemberMutationConfirmed } from '../max/max-client.service';
import {
  ModerationSanctionStateChangedError,
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockUnavailableError,
} from '../moderation/moderation-sanction-state-lock.service';
import { ManualModerationService } from './manual-moderation.service';
import { isAmbiguousAttemptedMaxMemberMutation } from './admin-manual-moderation-values';

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminManualModerationController {
  constructor(private readonly moderationService: ManualModerationService) {}

  @Get('chats/:chatId/sanctions')
  getChatSanctions(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatSanctions(chatId, user, query);
  }

  @Get('channels/:chatId/stats')
  getChannelStats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChannelStats(chatId, user, query);
  }

  @Get('channels/:chatId/activity-feed')
  getChannelActivityFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChannelActivityFeed(chatId, user, query);
  }

  @Get('chats/:chatId/activity-feed')
  getChatActivityFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatActivityFeed(chatId, user, query);
  }

  @Get('chats/:chatId/moderation-feed')
  getChatModerationFeed(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatModerationFeed(chatId, user, query);
  }

  @Get('chats/:chatId/moderation-dashboard')
  getChatModerationDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, {
      ...(query && typeof query === 'object' ? (query as Record<string, unknown>) : {}),
      includeActivityPreview: false,
      includeModerationPreview: true,
    });
  }

  @Get('chats/:chatId/activity-dashboard')
  getChatActivityDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, {
      ...(query && typeof query === 'object' ? (query as Record<string, unknown>) : {}),
      includeActivityPreview: true,
      includeModerationPreview: false,
    });
  }

  @Get('chats/:chatId/members')
  getChatParticipantsPage(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatParticipantsPage(chatId, user, query);
  }

  @Get('chats/:chatId/members/:userId')
  getChatParticipantDetails(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getChatParticipantDetails(chatId, targetUserId, user, query);
  }

  @Put('chats/:chatId/members/:userId/immunity')
  updateChatParticipantImmunity(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.updateChatParticipantImmunity(chatId, targetUserId, user, body);
  }

  @Post('chats/:chatId/members/unavailable-cleanup')
  cleanupUnavailableChatParticipants(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.cleanupUnavailableChatParticipants(chatId, user, body);
  }

  @Get('chats/:chatId/moderation-events')
  getEvents(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getEvents(chatId, user, query);
  }

  @Get('chats/:chatId/logs-dashboard')
  getLogsDashboard(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getLogsDashboard(chatId, user, query);
  }

  @Get('chats/:chatId/spammer-review')
  getGlobalSpammerReviewQueue(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getGlobalSpammerReviewQueue(chatId, user, query);
  }

  @Get('chats/:chatId/spammer-review/metrics')
  getGlobalSpammerReviewMetrics(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getGlobalSpammerReviewMetrics(chatId, user, query);
  }

  @Get('chats/:chatId/spammer-diagnostics/:userId')
  getGlobalSpammerUserDiagnostics(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
  ) {
    return this.moderationService.getGlobalSpammerUserDiagnostics(
      chatId,
      targetUserId,
      user,
      query,
    );
  }

  @Post('chats/:chatId/spammer-review/:userId')
  reviewGlobalSpammerCandidate(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.reviewGlobalSpammerCandidate(chatId, targetUserId, user, body);
  }

  @Post('chats/:chatId/members/:userId/moderation-action')
  async applyManualModerationAction(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    try {
      return await this.moderationService.applyManualModerationAction(
        chatId,
        targetUserId,
        user,
        body,
      );
    } catch (error: unknown) {
      this.throwModerationActionError(error);
    }
  }

  @Post('channels/:chatId/members/:userId/ban')
  async banChannelMember(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    try {
      return await this.moderationService.banChannelMember(chatId, targetUserId, user);
    } catch (error: unknown) {
      this.throwModerationActionError(error);
    }
  }

  private throwModerationActionError(error: unknown): never {
    // FLAG: A confirmed or ambiguous attempted effect must never invite a second mutation.
    if (
      wasMaxMemberMutationConfirmed(error) ||
      isAmbiguousAttemptedMaxMemberMutation(error) ||
      error instanceof ModerationSanctionStateLockUnavailableError ||
      error instanceof ModerationSanctionStateLockLeaseLostError
    ) {
      throw new ServiceUnavailableException({
        code: 'MODERATION_ACTION_STATUS_UNCERTAIN',
        message: 'Статус действия временно недоступен. Обновите список участников.',
        retryable: false,
      });
    }
    if (error instanceof ModerationSanctionStateLockBusyError) {
      throw new ConflictException({
        code: 'MODERATION_ACTION_IN_PROGRESS',
        message: 'Действие для этого участника уже выполняется. Дождитесь результата.',
      });
    }
    if (error instanceof ModerationSanctionStateChangedError) {
      throw new ConflictException({
        code: 'MODERATION_ACTION_STATE_CHANGED',
        message: 'Состояние участника уже изменилось. Обновите список участников.',
      });
    }
    throw error;
  }

  @Post('chats/:chatId/admin-allowlist')
  addAdmin(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.moderationService.addAdmin(chatId, user, body);
  }

  @Delete('chats/:chatId/admin-allowlist/:userId')
  removeAdmin(
    @Param('chatId') chatId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeAdmin(chatId, user, targetUserId);
  }

  @Post('chats/:chatId/domain-allowlist')
  addDomain(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.moderationService.addDomain(chatId, user, body);
  }

  @Get('chats/:chatId/domain-allowlist')
  getDomainAllowlist(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.moderationService.getDomainAllowlist(chatId, user);
  }

  @Get('chats/:chatId/domain-allowlist/details')
  getDomainAllowlistDetails(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.moderationService.getDomainAllowlistDetails(chatId, user);
  }

  @Delete('chats/:chatId/domain-allowlist')
  removeDomainByQuery(
    @Param('chatId') chatId: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeDomain(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery),
    );
  }

  @Delete('chats/:chatId/domain-allowlist/:domain')
  removeDomain(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.moderationService.removeDomain(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery, domain),
    );
  }

  @Put('chats/:chatId/domain-allowlist/removal-schedule')
  scheduleDomainRemovalByQuery(
    @Param('chatId') chatId: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.scheduleDomainRemoval(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery),
      body,
    );
  }

  @Put('chats/:chatId/domain-allowlist/:domain/removal-schedule')
  scheduleDomainRemoval(
    @Param('chatId') chatId: string,
    @Param('domain') domain: string,
    @Query('domain') domainQuery: string | undefined,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.moderationService.scheduleDomainRemoval(
      chatId,
      user,
      this.resolveAllowlistDomain(domainQuery, domain),
      body,
    );
  }

  private resolveAllowlistDomain(
    queryDomain: string | undefined,
    pathDomain?: string | undefined,
  ): string {
    const normalizedQueryDomain = queryDomain?.trim();
    if (normalizedQueryDomain) {
      return normalizedQueryDomain;
    }

    const normalizedPathDomain = pathDomain?.trim();
    if (normalizedPathDomain) {
      return normalizedPathDomain;
    }

    throw new BadRequestException('Allowlist domain is required');
  }
}
