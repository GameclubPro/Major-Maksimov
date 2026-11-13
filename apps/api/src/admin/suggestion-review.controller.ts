import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentMiniappProfile, MiniappProfiles } from '../auth/miniapp-profile';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { SuggestionReviewService } from './suggestion-review.service';

@Controller('v1/suggestion-reviews')
@UseGuards(InitDataGuard)
@MiniappProfiles('moderation', 'publisher')
export class SuggestionReviewController {
  constructor(private readonly reviews: SuggestionReviewService) {}
  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reviews.get(id, profile, user);
  }
  @Post(':id/save')
  save(
    @Param('id') id: string,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.reviews.save(id, profile, user, body);
  }
  @Post(':id/publish')
  publish(
    @Param('id') id: string,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.reviews.publish(id, profile, user, body);
  }
  @Post(':id/preview')
  preview(
    @Param('id') id: string,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.reviews.preview(id, profile, user, body);
  }
  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
  ) {
    return this.reviews.reject(id, profile, user, body);
  }
  @Get(':id/assets/:assetId')
  async asset(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @CurrentMiniappProfile() profile: MiniappProfile,
    @CurrentUser() user: AuthUser,
    @Res() reply: FastifyReply,
  ) {
    const asset = await this.reviews.asset(id, assetId, profile, user);
    reply
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .type(asset.mimeType)
      .send(asset.bytes);
  }
}
