import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PublisherVkBotReviewQueueService } from '../publisher/publisher-vk-bot-review.queue';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { VkParsingService } from './vk-parsing.service';

@Injectable()
export class VkParsingRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VkParsingRunnerService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly vkParsingService: VkParsingService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    @Optional() private readonly botReviews?: PublisherVkBotReviewQueueService,
  ) {}

  onModuleInit(): void {
    this.assertPublisherRuntime();
    if (!this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    const intervalMs = this.vkParsingService.getSchedulerIntervalMs();
    this.timer = setInterval(() => void this.run('scheduled'), intervalMs);
    this.timer.unref?.();
    setTimeout(() => void this.run('startup'), Math.min(30_000, intervalMs)).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(reason: 'startup' | 'scheduled'): Promise<void> {
    this.assertPublisherRuntime();
    if (!this.runtimeBoundary.dispatchEnabled || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      try {
        await this.vkParsingService.syncDueSources(reason);
      } catch (error) {
        this.logger.warn({ err: error, reason }, 'VK parsing source scheduling failed');
      }

      try {
        await this.vkParsingService.reconcileAutoPublishSchedules();
      } catch (error) {
        this.logger.warn({ err: error, reason }, 'VK autopublish schedule reconciliation failed');
      }

      try {
        await this.vkParsingService.recoverStalePublishJobs();
      } catch (error) {
        this.logger.warn({ err: error, reason }, 'VK parsing publish recovery failed');
      }

      try {
        await this.vkParsingService.enqueueDueAutoDeletes();
      } catch (error) {
        this.logger.warn({ err: error, reason }, 'VK auto-delete scheduling failed');
      }

      try {
        await this.vkParsingService.recoverStalePublisherRollbackJobs();
      } catch (error) {
        this.logger.warn({ err: error, reason }, 'VK parsing rollback recovery failed');
      }
      try {
        await this.botReviews?.enqueueTick();
      } catch (error) {
        this.logger.warn({ err: error }, 'VK review recovery scheduling failed');
      }
    } finally {
      this.inFlight = false;
    }
  }

  private assertPublisherRuntime(): void {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('VK parsing runner may only run inside api-publisher');
    }
  }
}
