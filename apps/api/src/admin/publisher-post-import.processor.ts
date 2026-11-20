import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from '../publisher/publisher-dispatch-job-guard';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import {
  PUBLISHER_POST_IMPORT_QUEUE,
  type PublisherPostImportJob,
  PublisherPostImportQueueService,
} from '../publisher/publisher-post-import.queue';
import { PublisherPostImportDeliveryService } from './publisher-post-import-delivery.service';
import { PublisherPostImportProcessingService } from './publisher-post-import-processing.service';

@Processor(PUBLISHER_POST_IMPORT_QUEUE, { concurrency: 3 })
export class PublisherPostImportProcessor extends WorkerHost {
  constructor(
    private readonly processing: PublisherPostImportProcessingService,
    private readonly delivery: PublisherPostImportDeliveryService,
    private readonly queue: PublisherPostImportQueueService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
  ) {
    super();
  }

  async process(job: Job<PublisherPostImportJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher post import claimed outside api-publisher');
    }
    if (job.data.version !== 1) {
      throw new Error('Unsupported publisher post import job version');
    }
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);
    if (job.data.kind === 'notify') {
      await this.delivery.deliver(job.data);
      return;
    }
    const configuredAttempts = job.opts?.attempts;
    const maxAttempts =
      typeof configuredAttempts === 'number' && Number.isFinite(configuredAttempts)
        ? Math.max(1, Math.trunc(configuredAttempts))
        : 1;
    const lastAttempt = (job.attemptsMade ?? 0) + 1 >= maxAttempts;
    let result: Awaited<ReturnType<PublisherPostImportProcessingService['process']>>;
    try {
      result = await this.processing.process(job.data.sessionId, lastAttempt);
    } catch (error: unknown) {
      if (lastAttempt) {
        const failed = await this.processing.failInternalAfterFinalAttempt(job.data.sessionId);
        if (failed) {
          await this.queue.enqueueNotification({
            sessionId: job.data.sessionId,
            notification: 'failed',
            dedupeKey: 'terminal-internal-error',
          });
        }
      }
      throw error;
    }
    if (result === 'ready' || result === 'failed') {
      await this.queue.enqueueNotification({
        sessionId: job.data.sessionId,
        notification: result,
        dedupeKey: `terminal-${result}`,
      });
    }
  }
}
