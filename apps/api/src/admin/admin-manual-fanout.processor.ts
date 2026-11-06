import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ADMIN_MANUAL_FANOUT_QUEUE, type AdminManualFanoutJob } from './admin-manual-fanout.queue';
import { ManualModerationService } from './manual-moderation.service';

@Processor(ADMIN_MANUAL_FANOUT_QUEUE, {
  concurrency: 1,
})
export class AdminManualFanoutProcessor extends WorkerHost {
  constructor(private readonly manualModerationService: ManualModerationService) {
    super();
  }

  async process(job: Job<AdminManualFanoutJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.manualModerationService.processManualModerationFanoutJob(job.data);
  }
}
