import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { InitDataGuard } from '../auth/init-data.guard';
import { CurrentMiniappProfile, MiniappProfiles } from '../auth/miniapp-profile';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { CurrentUser, type AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationDispatchProfile } from '../prisma/prisma-client';
import { PublisherFeatureV2RequiredException } from '../publisher/publisher-errors';
import { throwLegacyPublicationWritesDisabled } from './legacy-publication-write-freeze';
import { PublicationMetricsInterceptor } from './publication-metrics.interceptor';
import { PublicationPublisherTargetRefreshService } from './publication-publisher-target-refresh.service';
import { PublicationService } from './publication.service';

@Controller('v1/publications')
@UseGuards(InitDataGuard)
@MiniappProfiles('publisher')
@UseInterceptors(PublicationMetricsInterceptor)
export class PublicationController {
  constructor(
    private readonly publicationService: PublicationService,
    private readonly publisherTargetRefresh: PublicationPublisherTargetRefreshService,
  ) {}

  @Get()
  @MiniappProfiles('publisher')
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.list(user, query, this.toDispatchProfile(profile));
  }

  @Post()
  @MiniappProfiles('publisher')
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.create(user, body, this.toDispatchProfile(profile));
  }

  @Post('test')
  @MiniappProfiles('publisher')
  test(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    if (profile === 'publisher') {
      throw new PublisherFeatureV2RequiredException();
    }
    void user;
    void body;
    throwLegacyPublicationWritesDisabled();
  }

  @Post('calendar-availability')
  @MiniappProfiles('publisher')
  calendarAvailability(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.getCalendarAvailability(
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post('schedule-preview')
  @HttpCode(HttpStatus.OK)
  @MiniappProfiles('publisher')
  schedulePreview(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.previewSchedule(user, body, this.toDispatchProfile(profile));
  }

  @Get('legacy')
  @MiniappProfiles('publisher')
  listLegacy(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    void user;
    void query;
    throwLegacyPublicationWritesDisabled();
  }

  @Get(':publicationId')
  @MiniappProfiles('publisher')
  get(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.get(publicationId, user, this.toDispatchProfile(profile));
  }

  @Post(':publicationId/targets/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  @MiniappProfiles('publisher')
  refreshTargets(@Param('publicationId') publicationId: string, @CurrentUser() user: AuthUser) {
    return this.publisherTargetRefresh.request(publicationId, user);
  }

  @Put(':publicationId')
  @MiniappProfiles('publisher')
  update(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.update(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/pause')
  @MiniappProfiles('publisher')
  pause(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.pause(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/resume')
  @MiniappProfiles('publisher')
  resume(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.resume(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/cancel')
  @MiniappProfiles('publisher')
  cancel(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.cancel(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Delete(':publicationId')
  @MiniappProfiles('publisher')
  remove(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.cancel(
      publicationId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Get(':publicationId/deliveries')
  @MiniappProfiles('publisher')
  deliveries(
    @Param('publicationId') publicationId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.listDeliveries(
      publicationId,
      user,
      query,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/occurrences/:occurrenceId/skip')
  @MiniappProfiles('publisher')
  skipOccurrence(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.skipOccurrence(
      publicationId,
      occurrenceId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/occurrences/:occurrenceId/reschedule')
  @MiniappProfiles('publisher')
  rescheduleOccurrence(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.rescheduleOccurrence(
      publicationId,
      occurrenceId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/occurrences/:occurrenceId/retry')
  @MiniappProfiles('publisher')
  retryOccurrence(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.retryOccurrence(
      publicationId,
      occurrenceId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  @Post(':publicationId/occurrences/:occurrenceId/resolve-ambiguous')
  @MiniappProfiles('publisher')
  resolveAmbiguous(
    @Param('publicationId') publicationId: string,
    @Param('occurrenceId') occurrenceId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @CurrentMiniappProfile() profile: MiniappProfile = 'publisher',
  ) {
    return this.publicationService.resolveAmbiguousDelivery(
      publicationId,
      occurrenceId,
      user,
      body,
      this.toDispatchProfile(profile),
    );
  }

  private toDispatchProfile(profile: MiniappProfile): PublicationDispatchProfile {
    if (profile !== 'publisher') {
      throwLegacyPublicationWritesDisabled();
    }
    return PublicationDispatchProfile.PUBLIK_V1;
  }
}
