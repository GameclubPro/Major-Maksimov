import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { NetworkSettingsMetadataService } from './network-settings-metadata.service';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { NetworkSettingsService } from './network-settings.service';
import { MajorNetworksGuard } from './major-networks.guard';

const pagingSchema = z.literal('adaptive').optional();

@Controller('v1/networks/settings')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation')
export class NetworkSettingsController {
  constructor(
    private readonly settings: NetworkSettingsService,
    private readonly metadata: NetworkSettingsMetadataService,
  ) {}
  @Post('required-subscription/resolve')
  @UseGuards(MajorNetworksGuard)
  resolveRequiredSubscription(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.metadata.resolveRequiredSubscription(user, body);
  }
  @Post('admin-contacts/read')
  @UseGuards(MajorNetworksGuard)
  readAdminContacts(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.metadata.readAdminContacts(user, body);
  }
  @Post('admin-contacts/resolve')
  @UseGuards(MajorNetworksGuard)
  resolveAdminContact(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.metadata.resolveAdminContact(user, body);
  }
  @Post('read')
  @UseGuards(MajorNetworksGuard)
  read(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Query('paging') paging: unknown,
    @Req() request: FastifyRequest,
  ) {
    const parsed = pagingSchema.safeParse(paging);
    if (!parsed.success) throw new BadRequestException('Некорректный режим чтения.');
    return this.settings.read(user, body, {
      adaptive: parsed.data === 'adaptive',
      disconnected: () => request.raw.socket.destroyed,
    });
  }
  @Post('navigation-allowlist/read')
  @UseGuards(MajorNetworksGuard)
  readAllowlist(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.settings.readNavigationAllowlist(user, body);
  }
  @Post('preview')
  @UseGuards(MajorNetworksGuard)
  preview(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.settings.preview(user, body);
  }
  @Post('apply')
  @UseGuards(MajorNetworksGuard)
  apply(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.settings.apply(user, body);
  }
  @Get('operations/:operationId') status(
    @CurrentUser() user: AuthUser,
    @Param('operationId') operationId: string,
  ) {
    return this.settings.status(user, operationId);
  }
}
