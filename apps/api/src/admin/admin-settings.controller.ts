import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { duplicateDiagnosticsQuerySchema } from '@maxim/contracts/settings';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { AdminSettingsService } from './admin-settings.service';

const recheckBotCapabilitiesSchema = z.literal('1').optional();
function parseBotCapabilityRecheck(value: unknown): boolean {
  const parsed = recheckBotCapabilitiesSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('recheckBotCapabilities must equal 1');
  return parsed.data === '1';
}

@Controller('v1')
@UseGuards(InitDataGuard)
export class AdminSettingsController {
  constructor(private readonly settingsService: AdminSettingsService) {}

  @Get('chats/:chatId/settings')
  getSettings(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getSettings(chatId, user);
  }

  @Get('chats/:chatId/closure-status')
  getChatClosureSummary(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getChatClosureSummary(chatId, user);
  }

  @Get('chats/:chatId/settings-screen')
  getChatSettingsScreen(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getChatSettingsScreen(chatId, user);
  }

  @Get('chats/:chatId/duplicate-diagnostics')
  getDuplicateDiagnostics(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Query() query?: unknown,
  ) {
    const page = duplicateDiagnosticsQuerySchema.safeParse(query ?? {});
    if (!page.success) throw new BadRequestException('Invalid duplicate diagnostics page');
    return query === undefined
      ? this.settingsService.getDuplicateDiagnostics(chatId, user)
      : this.settingsService.getDuplicateDiagnostics(chatId, user, false, page.data);
  }

  @Post('chats/:chatId/duplicate-diagnostics/recheck')
  recheckDuplicateDiagnostics(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getDuplicateDiagnostics(chatId, user, true);
  }

  @Get('chats/:chatId/duplicate-diagnostics/:intentId/message-link/:role')
  getDuplicateMessageLink(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Param('intentId') intentId: string,
    @Param('role') role: string,
  ) {
    if (
      !z.string().min(1).max(512).safeParse(intentId).success ||
      !['target', 'original'].includes(role)
    )
      throw new BadRequestException('Invalid duplicate message link target');
    return this.settingsService.getDuplicateMessageLink(
      chatId,
      user,
      intentId,
      role as 'target' | 'original',
    );
  }

  @Post('chats/:chatId/required-subscription/channels/resolve')
  resolveRequiredSubscriptionChannel(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.resolveRequiredSubscriptionChannel(chatId, user, body);
  }

  @Put('chats/:chatId/settings')
  updateSettings(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Query('recheckBotCapabilities') recheckBotCapabilities?: unknown,
  ) {
    // FLAG: Revisionless public PUT must not restore a stale full client snapshot.
    if (
      !body ||
      typeof body !== 'object' ||
      !('settingsRevision' in body) ||
      typeof body.settingsRevision !== 'string'
    ) {
      throw new HttpException(
        {
          code: 'CHAT_SETTINGS_REVISION_REQUIRED',
          message: 'Обновите экран настроек перед сохранением.',
        },
        428,
      );
    }
    return this.settingsService.updateSettings(chatId, user, body, 'miniapp', {
      forceLiveBotCapabilityCheck: parseBotCapabilityRecheck(recheckBotCapabilities),
    });
  }

  @Patch('chats/:chatId/settings/section')
  patchSettingsSection(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Query('recheckBotCapabilities') recheckBotCapabilities?: unknown,
  ) {
    return this.settingsService.patchSettingsSection(chatId, user, body, {
      forceLiveBotCapabilityCheck: parseBotCapabilityRecheck(recheckBotCapabilities),
    });
  }

  @Patch('chats/:chatId/settings/speech-style')
  updateBotSpeechStyle(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.updateBotSpeechStyle(chatId, user, body);
  }

  @Get('chats/:chatId/rules')
  getRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getRules(chatId, user);
  }

  @Put('chats/:chatId/rules')
  updateRules(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    // FLAG: An older open editor cannot overwrite a group rules revision it never read.
    if (
      !body ||
      typeof body !== 'object' ||
      !('expectedRevision' in body) ||
      (body.expectedRevision !== null && typeof body.expectedRevision !== 'string')
    )
      throw new HttpException(
        {
          code: 'CHAT_RULES_REVISION_REQUIRED',
          message: 'Обновите экран правил перед сохранением.',
        },
        428,
      );
    return this.settingsService.updateRules(chatId, user, body);
  }

  @Post('chats/:chatId/rules/publish')
  publishRules(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body?: unknown,
  ) {
    return this.settingsService.publishRules(chatId, user, 'miniapp', body);
  }

  @Delete('chats/:chatId/rules/publish')
  resetPublishedRules(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.resetPublishedRules(chatId, user);
  }

  @Get('channels/:chatId/settings')
  getChannelSettings(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getChannelSettings(chatId, user);
  }

  @Get('channels/:chatId/settings-screen')
  getChannelSettingsScreen(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getChannelSettingsScreen(chatId, user);
  }

  @Put('channels/:chatId/settings')
  updateChannelSettings(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.updateChannelSettings(chatId, user, body);
  }

  @Get('channels/:chatId/post-signature')
  getChannelPostSignature(@Param('chatId') chatId: string, @CurrentUser() user: AuthUser) {
    return this.settingsService.getChannelPostSignature(chatId, user);
  }

  @Patch('channels/:chatId/post-signature')
  updateChannelPostSignature(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.updateChannelPostSignature(chatId, user, body);
  }

  @Post('channels/:chatId/engagement-publish')
  publishChannelEngagementMessage(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.publishChannelEngagementMessage(chatId, user, body);
  }

  @Post('chats/:chatId/settings/apply-to-all')
  applySettingsToAllChats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.applySettingsToAllChats(chatId, user, body);
  }

  @Post('chats/:chatId/settings/apply-section-to-all')
  applySettingsSectionToAllChats(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.applySettingsSectionToAllChats(chatId, user, body);
  }

  @Post('chats/:chatId/settings/apply-section-preview')
  previewApplySettingsSectionTarget(
    @Param('chatId') chatId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.settingsService.previewApplySettingsSectionTarget(chatId, user, body);
  }
}
