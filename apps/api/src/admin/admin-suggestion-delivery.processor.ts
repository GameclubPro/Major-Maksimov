import { SuggestionNativeService } from './suggestion-native.service';
import { SuggestionReviewEffectsService } from './suggestion-review-effects.service';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  ADMIN_SUGGESTION_DELIVERY_QUEUE,
  type AdminSuggestionDeliveryJob,
} from './admin-suggestion-delivery.queue';
import { ChannelDialogService } from './channel-dialog.service';

@Processor(ADMIN_SUGGESTION_DELIVERY_QUEUE, {
  concurrency: 2,
})
export class AdminSuggestionDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(AdminSuggestionDeliveryProcessor.name);

  constructor(
    private readonly channelDialogService: ChannelDialogService,
    private readonly reviewEffects: SuggestionReviewEffectsService,
    private readonly nativeReview: SuggestionNativeService,
  ) {
    super();
  }

  async process(job: Job<AdminSuggestionDeliveryJob>) {
    if (!roleRunsAction(getAppRole())) {
      throw new Error('Admin suggestion delivery job received by a non-action API role');
    }

    if ('kind' in job.data && job.data.kind === 'suggestion-native') {
      if (job.data.profile !== 'moderation') throw new Error('Wrong native review worker');
      await this.nativeReview.process(job.data, {
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      });
      return;
    }
    if ('kind' in job.data && job.data.kind === 'review-effect') {
      await this.reviewEffects.process(job.data.effectId, 'moderation');
      return;
    }
    if (!('auditLogId' in job.data)) return;
    try {
      await this.channelDialogService.processChannelSuggestionDeliveryJob(job.data.auditLogId);
      await this.reviewEffects.syncAfterDelivery(job.data.auditLogId, 'moderation');
    } catch (error: unknown) {
      const maxAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
      try {
        await this.channelDialogService.recordChannelSuggestionDeliveryJobFailure(
          job.data.auditLogId,
          error,
          {
            final: job.attemptsMade + 1 >= maxAttempts,
            attemptsMade: job.attemptsMade + 1,
            maxAttempts,
          },
        );
      } catch (recordError: unknown) {
        this.logger.warn(
          {
            auditLogId: job.data.auditLogId,
            err: recordError instanceof Error ? recordError.message : String(recordError),
          },
          'Failed to record channel suggestion delivery job failure',
        );
      }
      throw error;
    }
  }
}
