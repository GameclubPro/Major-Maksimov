import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import type { MaxActionJob } from './max-client.service';
import { consumeMaxSendCapacityDeferral } from './max-send-capacity-deferral';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_LEGACY_QUEUE,
} from './max-action.queue';

abstract class MaxActionWorkerHost extends WorkerHost {
  constructor(private readonly maxActionDispatchService: MaxActionDispatchService) {
    super();
  }

  async process(job: Job<MaxActionJob>, token?: string) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    const attempt = Math.max(1, job.attemptsMade + 1);
    const maxAttempts =
      typeof job.opts.attempts === 'number' && Number.isFinite(job.opts.attempts)
        ? Math.max(1, Math.trunc(job.opts.attempts))
        : 1;
    const enqueuedAtCandidate =
      typeof job.timestamp === 'number' && Number.isFinite(job.timestamp) && job.timestamp > 0
        ? new Date(job.timestamp)
        : undefined;
    const enqueuedAt =
      enqueuedAtCandidate && Number.isFinite(enqueuedAtCandidate.getTime())
        ? enqueuedAtCandidate
        : undefined;

    try {
      await this.maxActionDispatchService.execute(
        {
          ...job.data,
          attempt,
        },
        {
          finalAttempt: attempt >= maxAttempts,
          ...(enqueuedAt ? { enqueuedAt } : {}),
          ...(token?.trim() ? { deferSendCapacity: true } : {}),
        },
      );
    } catch (error) {
      if (token?.trim() && consumeMaxSendCapacityDeferral(error, job.data)) {
        // FLAG: A timeout or failed lock transition is not a delayed acknowledgement.
        // Preserve this job's identity, payload, deadline and ordinary attempt count.
        await job.moveToDelayed(error.retryAtMs, token);
        throw new DelayedError();
      }
      throw error;
    }
  }
}

@Processor(MAX_ACTION_LEGACY_QUEUE, {
  concurrency: Number(process.env.ACTION_CONCURRENCY ?? 24),
})
export class MaxActionProcessor extends MaxActionWorkerHost {
  constructor(maxActionDispatchService: MaxActionDispatchService) {
    super(maxActionDispatchService);
  }
}

@Processor(MAX_ACTION_CRITICAL_QUEUE, {
  concurrency: Number(process.env.MAX_ACTION_CRITICAL_CONCURRENCY ?? 3),
})
export class MaxActionCriticalProcessor extends MaxActionWorkerHost {
  constructor(maxActionDispatchService: MaxActionDispatchService) {
    super(maxActionDispatchService);
  }
}

@Processor(MAX_ACTION_INTERACTIVE_QUEUE, {
  concurrency: Number(process.env.MAX_ACTION_INTERACTIVE_CONCURRENCY ?? 2),
})
export class MaxActionInteractiveProcessor extends MaxActionWorkerHost {
  constructor(maxActionDispatchService: MaxActionDispatchService) {
    super(maxActionDispatchService);
  }
}

@Processor(MAX_ACTION_BACKGROUND_QUEUE, {
  concurrency: Number(process.env.MAX_ACTION_BACKGROUND_CONCURRENCY ?? 1),
})
export class MaxActionBackgroundProcessor extends MaxActionWorkerHost {
  constructor(maxActionDispatchService: MaxActionDispatchService) {
    super(maxActionDispatchService);
  }
}
