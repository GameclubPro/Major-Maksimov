import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Logger, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { spammerDenormProcessorEnabled } from '../runtime/moderation-runtime';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';
import {
  GLOBAL_SPAMMER_DENORM_QUEUE,
  type GlobalSpammerDenormJob,
} from './global-spammer-denorm.queue';

@Processor(GLOBAL_SPAMMER_DENORM_QUEUE, {
  concurrency: 1,
})
export class GlobalSpammerDenormProcessor
  extends WorkerHost
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(GlobalSpammerDenormProcessor.name);
  private recoveryTimer?: NodeJS.Timeout;
  private recovering = false;

  onModuleInit(): void {
    if (!spammerDenormProcessorEnabled(this.configService)) return;
    this.recoveryTimer = setInterval(() => {
      void this.recover();
    }, 30_000);
    this.recoveryTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.recoveryTimer);
  }

  private async recover(): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await this.globalSpammerIntelligence.recoverPendingObservationProjections();
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Spammer observation recovery failed',
      );
    } finally {
      this.recovering = false;
    }
  }

  constructor(
    private readonly globalSpammerIntelligence: GlobalSpammerIntelligenceService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    super();
  }

  async process(job: Job<GlobalSpammerDenormJob>): Promise<void> {
    if (!spammerDenormProcessorEnabled(this.configService)) {
      return;
    }

    await this.globalSpammerIntelligence.processObservationDenormJob(job.data);
  }
}
