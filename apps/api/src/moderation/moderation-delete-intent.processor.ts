import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  MODERATION_DELETE_INTENT_QUEUE,
  type ModerationDeleteIntentJob,
} from './moderation-delete-intent.queue';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';

@Processor(MODERATION_DELETE_INTENT_QUEUE, {
  concurrency: Number(process.env.MODERATION_DELETE_INTENT_CONCURRENCY ?? 2),
})
export class ModerationDeleteIntentProcessor extends WorkerHost {
  constructor(private readonly deleteIntents: ModerationDeleteIntentService) {
    super();
  }

  async process(job: Job<ModerationDeleteIntentJob>): Promise<void> {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.deleteIntents.processQueuedIntent(job.data.intentId);
  }
}
