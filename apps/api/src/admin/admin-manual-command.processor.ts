import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import type { AdminManualFanoutJob } from './admin-manual-fanout.queue';
import { ADMIN_MANUAL_COMMAND_QUEUE } from './admin-manual-command.queue';
import { ManualModerationService } from './manual-moderation.service';

@Processor(ADMIN_MANUAL_COMMAND_QUEUE, {
  concurrency: 1,
})
export class AdminManualCommandProcessor extends WorkerHost {
  constructor(private readonly manualModerationService: ManualModerationService) {
    super();
  }

  async process(job: Job<AdminManualFanoutJob>) {
    if (!roleRunsAction(getAppRole())) return;
    // FLAG: Background payloads must never consume the slot reserved for commands.
    if (job.data.kind !== 'manual_group_moderation_command') {
      throw new UnrecoverableError('Unsupported manual command job kind');
    }
    await this.manualModerationService.processManualModerationFanoutJob(job.data);
  }
}
