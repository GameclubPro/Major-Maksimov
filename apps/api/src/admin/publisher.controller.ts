import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ManagedEntityType } from '@maxim/contracts/publisher';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublisherEntityRefreshService } from './publisher-entity-refresh.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import { PublisherPostImportService } from '../publisher/publisher-post-import.service';
import { PublisherAutoReplyService } from './publisher-auto-reply.service';
import { PublisherAutoReplyAuthoringService } from '../publisher/publisher-auto-reply-authoring.service';

@Controller('v1/publisher')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
export class PublisherController {
  constructor(
    private readonly policyService: PublisherPolicyService,
    private readonly entityRefreshService: PublisherEntityRefreshService,
    private readonly suggestionService: PublisherSuggestionService,
    private readonly postImportService: PublisherPostImportService,
    private readonly autoReplyService: PublisherAutoReplyService,
    private readonly autoReplyAuthoringService: PublisherAutoReplyAuthoringService,
  ) {}

  @Post('post-imports')
  createPostImport(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Query('contractVersion') contractVersion?: unknown,
  ) {
    return this.postImportService.create(
      user,
      body,
      this.parseImportContractVersion(contractVersion),
    );
  }

  @Get('post-imports')
  getPostImport(
    @CurrentUser() user: AuthUser,
    @Query('contractVersion') contractVersion?: unknown,
  ) {
    return this.postImportService.getCurrent(
      user,
      this.parseImportContractVersion(contractVersion),
    );
  }

  @Get('post-imports/active')
  getActivePostImport(
    @CurrentUser() user: AuthUser,
    @Query('contractVersion') contractVersion?: unknown,
  ) {
    return this.postImportService.getCurrent(
      user,
      this.parseImportContractVersion(contractVersion),
    );
  }

  @Get('post-imports/by-token/:startToken')
  getPostImportByToken(
    @Param('startToken') startToken: string,
    @CurrentUser() user: AuthUser,
    @Query('contractVersion') contractVersion?: unknown,
  ) {
    return this.postImportService.getByToken(
      user,
      startToken,
      this.parseImportContractVersion(contractVersion),
    );
  }

  @Delete('post-imports')
  cancelPostImport(
    @CurrentUser() user: AuthUser,
    @Query('contractVersion') contractVersion?: unknown,
  ) {
    return this.postImportService.cancel(user, this.parseImportContractVersion(contractVersion));
  }

  @Get('post-imports/:sessionId/assets/:assetId')
  async getPostImportAsset(
    @Param('sessionId') sessionId: string,
    @Param('assetId') assetId: string,
    @CurrentUser() user: AuthUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const asset = await this.postImportService.getImageAsset(sessionId, assetId, user);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type(asset.mimeType);
    reply.send(asset.bytes);
  }

  @Get('entities')
  listEntities(@CurrentUser() user: AuthUser, @Query() query?: unknown) {
    return this.policyService.listEntities(user, query);
  }

  @Get('refresh-operations/:operationId')
  getRefreshOperation(@Param('operationId') operationId: string, @CurrentUser() user: AuthUser) {
    return this.entityRefreshService.getRefreshOperation(operationId, user);
  }

  @Get('entities/:entityType/:entityId')
  getEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.policyService.getEntity(this.parseEntityType(entityType), entityId, user);
  }

  @Get('entities/chat/:entityId/auto-replies')
  listAutoReplies(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Query('contractVersion') contractVersion?: string,
  ) {
    return this.autoReplyService.list(
      entityId,
      user,
      this.parseAutoReplyContractVersion(contractVersion),
    );
  }

  @Get('entities/chat/:entityId/auto-replies/:ruleId')
  getAutoReply(
    @Param('entityId') entityId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
    @Query('contractVersion') contractVersion?: string,
  ) {
    return this.autoReplyService.get(
      entityId,
      ruleId,
      user,
      this.parseAutoReplyContractVersion(contractVersion),
    );
  }

  @Post('entities/chat/:entityId/auto-replies/match-preview')
  previewAutoReplyMatch(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Query('contractVersion') contractVersion?: string,
  ) {
    const version = this.parseAutoReplyContractVersion(contractVersion);
    if (version !== 2) {
      throw new BadRequestException('Для проверки совпадения требуется contractVersion=2.');
    }
    return this.autoReplyService.previewMatch(entityId, user, body);
  }

  @Post('entities/chat/:entityId/auto-replies/authoring-sessions')
  async createAutoReplyAuthoringSession(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    await this.policyService.getEntity('chat', entityId, user);
    return this.autoReplyAuthoringService.create(user, entityId, body);
  }

  @Get('entities/chat/:entityId/auto-replies/authoring-sessions/current')
  async getCurrentAutoReplyAuthoringSession(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.policyService.getEntity('chat', entityId, user);
    return this.autoReplyAuthoringService.getCurrent(user, entityId);
  }

  @Delete('entities/chat/:entityId/auto-replies/authoring-sessions/current')
  async cancelCurrentAutoReplyAuthoringSession(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.policyService.getEntity('chat', entityId, user);
    return this.autoReplyAuthoringService.cancelCurrent(user, entityId);
  }

  @Post('entities/chat/:entityId/auto-replies')
  createAutoReply(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Query('contractVersion') contractVersion?: string,
  ) {
    return this.autoReplyService.create(
      entityId,
      user,
      body,
      this.parseAutoReplyContractVersion(contractVersion),
    );
  }

  @Patch('entities/chat/:entityId/auto-replies/:ruleId')
  updateAutoReply(
    @Param('entityId') entityId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Query('contractVersion') contractVersion?: string,
  ) {
    return this.autoReplyService.update(
      entityId,
      ruleId,
      user,
      body,
      this.parseAutoReplyContractVersion(contractVersion),
    );
  }

  @Delete('entities/chat/:entityId/auto-replies/:ruleId')
  archiveAutoReply(
    @Param('entityId') entityId: string,
    @Param('ruleId') ruleId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.autoReplyService.archive(entityId, ruleId, user, body);
  }

  @Get('entities/chat/:entityId/auto-replies/:ruleId/assets/:assetId')
  async getAutoReplyAsset(
    @Param('entityId') entityId: string,
    @Param('ruleId') ruleId: string,
    @Param('assetId') assetId: string,
    @CurrentUser() user: AuthUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const asset = await this.autoReplyService.getAsset(entityId, ruleId, assetId, user);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type(asset.mimeType);
    reply.send(asset.bytes);
  }

  @Post('entities/resolve')
  resolveEntities(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.policyService.resolveEntities(user, body);
  }

  @Get('entities/channel/:entityId/suggestions')
  listSuggestions(
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Query() query?: unknown,
  ) {
    return this.suggestionService.list(entityId, user, query);
  }

  @Post('entities/channel/:entityId/suggestions/:suggestionId/review')
  reviewSuggestion(
    @Param('entityId') entityId: string,
    @Param('suggestionId') suggestionId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.suggestionService.review(entityId, suggestionId, user, body);
  }

  @Post('entities/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshEntities(@CurrentUser() user: AuthUser) {
    return this.entityRefreshService.requestBulkRefresh(user);
  }

  @Post('entities/refresh-selected')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshSelectedEntities(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.entityRefreshService.requestSelectedEntitiesRefresh(body, user);
  }

  @Get('entities/:entityType/:entityId/policy')
  getPolicy(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.policyService.getPolicyForPublisher(
      this.parseEntityType(entityType),
      entityId,
      user,
    );
  }

  @Patch('entities/:entityType/:entityId/policy')
  updatePolicy(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.policyService.updatePolicy(this.parseEntityType(entityType), entityId, user, body);
  }

  @Patch('entities/:entityType/:entityId/modules')
  updateModules(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.policyService.updateModuleSettings(
      this.parseEntityType(entityType),
      entityId,
      user,
      body,
    );
  }

  @Post('entities/:entityType/:entityId/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshEntity(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.entityRefreshService.requestRefresh(
      this.parseEntityType(entityType),
      entityId,
      user,
    );
  }

  private parseEntityType(value: string): ManagedEntityType {
    if (value === 'chat' || value === 'channel') {
      return value;
    }
    throw new BadRequestException('Unsupported managed entity type');
  }

  private parseImportContractVersion(value: unknown): boolean {
    if (value === undefined || value === '1') return false;
    if (value === '2') return true;
    throw new BadRequestException('Недопустимая версия импорта.');
  }

  private parseAutoReplyContractVersion(value: string | undefined): 1 | 2 {
    if (value === undefined || value.trim() === '' || value === '1') {
      return 1;
    }
    if (value === '2') {
      return 2;
    }
    throw new BadRequestException('Unsupported Publisher auto-reply contract version');
  }
}
