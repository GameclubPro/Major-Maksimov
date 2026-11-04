import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { RuntimeOverviewReaderGuard } from './runtime-overview-reader.guard';
import { SafetyDeskOverviewService } from './safety-desk-overview.service';

@Controller('v1/safety-desk/runtime-observer')
@UseGuards(RuntimeOverviewReaderGuard)
export class RuntimeOverviewReaderController {
  constructor(
    @Inject(SafetyDeskOverviewService)
    private readonly overview: Pick<SafetyDeskOverviewService, 'getObserverSnapshot'>,
  ) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  getOverview() {
    return this.overview.getObserverSnapshot();
  }
}
