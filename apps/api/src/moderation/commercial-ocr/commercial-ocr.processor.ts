import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';

import { CommercialOcrAdmissionStore } from './commercial-ocr-admission.store';
import { CommercialOcrModerationService } from './commercial-ocr-moderation.service';
import { CommercialOcrMetricsService } from './commercial-ocr-metrics.service';
import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_DEFAULT_VERSION,
  COMMERCIAL_OCR_JOB_NAME,
  COMMERCIAL_OCR_LEGACY_JOB_SCHEMA_VERSION,
  COMMERCIAL_OCR_QUEUE,
  validateCommercialOcrImageCount,
  validateCommercialOcrVersion,
  isSupportedCommercialOcrJobSchemaVersion,
  resolveCommercialOcrJobEventTimestamp,
  COMMERCIAL_OCR_JOB_BACKOFF_MS,
  type CommercialOcrJob,
} from './commercial-ocr.queue';

import {
  isCommercialOcrTerminalResult,
  type CommercialOcrTerminalResult,
} from './commercial-ocr-terminal';

import {
  NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS_ENV,
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
  resolveNativeOcrSandboxExtraPaths,
} from './native-ocr-sandbox.protocol';

const MAX_DEFER_MS = 10 * 60_000;
const DEFAULT_MAX_JOB_AGE_MS = 5 * 60_000;
const DEFER_REASONS = new Set([
  'source_not_ready',
  'governor_pressure',
  'admission_pending',
  'native_backpressure',
] as const);
const RETRY_REASONS = new Set(['download_failed', 'ocr_failed', 'source_unavailable'] as const);

type CommercialOcrJobIdentity = {
  jobId: string;
  chatId: string;
};

type CommercialOcrDeferResult = {
  kind: 'defer';
  delayMs: number;
  reason: 'source_not_ready' | 'governor_pressure' | 'admission_pending' | 'native_backpressure';
};

type CommercialOcrRetryResult = {
  kind: 'retry';
  reason: 'download_failed' | 'ocr_failed' | 'source_unavailable';
  retryAfterMs?: number;
};

@Processor(COMMERCIAL_OCR_QUEUE, {
  concurrency:
    1 +
    resolveNativeOcrSandboxExtraPaths(
      process.env[NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV],
      process.env[NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS_ENV],
    ).length,
})
export class CommercialOcrProcessor extends WorkerHost {
  private readonly logger = new Logger(CommercialOcrProcessor.name);
  private readonly maxJobAgeMs: number;

  constructor(
    private readonly moderationService: CommercialOcrModerationService,
    private readonly admissionStore: CommercialOcrAdmissionStore,
    private readonly configService: ConfigService,
    private readonly metrics: CommercialOcrMetricsService,
  ) {
    super();
    this.maxJobAgeMs = readPositiveInteger(
      configService.get('COMMERCIAL_OCR_MAX_JOB_AGE_MS'),
      DEFAULT_MAX_JOB_AGE_MS,
    );
  }

  async process(job: Job<CommercialOcrJob>, token?: string): Promise<void> {
    let identity: CommercialOcrJobIdentity;
    let result: Awaited<ReturnType<CommercialOcrModerationService['processCommercialOcrJob']>>;

    try {
      identity = this.validateJobIdentity(job);
    } catch (error: unknown) {
      this.metrics.recordCounter('bullmq.job.invalid');
      throw asUnrecoverableError(error, 'Commercial OCR job identity is invalid');
    }

    try {
      this.validateJobEnvelope(job);
    } catch (error: unknown) {
      this.metrics.recordCounter('bullmq.job.invalid');
      await this.releaseAdmission(identity, job, {
        outcome: 'TECHNICAL_INCOMPLETE',
        reason: 'invalid_job',
      });
      throw asUnrecoverableError(error, 'Commercial OCR job envelope is invalid');
    }

    await this.recordLogicalStarted(job, identity);
    if ((job.attemptsStarted ?? 1) <= 1) {
      const processingStartedAtMs = job.processedOn ?? Date.now();
      this.metrics.recordQueueWait(Math.max(0, processingStartedAtMs - job.timestamp));
      this.metrics.recordCounter('bullmq.job.started');
      this.metrics.recordCounter(resolveAlbumImageCountMetric(job.data.imageCount));
    }

    const deadlineAtMs =
      Date.parse(resolveCommercialOcrJobEventTimestamp(job.data)) + this.maxJobAgeMs;
    if (deadlineAtMs <= Date.now()) {
      this.metrics.recordCounter('bullmq.job.expired');
      await this.releaseAdmission(identity, job, { outcome: 'EXPIRED', reason: 'expired' });
      return;
    }

    if (job.data.sourceRetryNotBeforeAt && job.data.sourceRetryNotBeforeAt > Date.now()) {
      await this.deferWithoutConsumingAttempt(
        job,
        token,
        identity,
        {
          kind: 'defer',
          delayMs: Math.min(MAX_DEFER_MS, job.data.sourceRetryNotBeforeAt - Date.now()),
          reason: 'source_not_ready',
        },
        deadlineAtMs,
      );
      return;
    }
    const processingStartedAt = performance.now();
    try {
      result = await this.moderationService.processCommercialOcrJob(
        job.data,
        identity.jobId,
        deadlineAtMs,
      );
    } catch (error: unknown) {
      this.metrics.recordCounter('bullmq.job.failed');
      if (error instanceof UnrecoverableError) {
        await this.releaseAdmission(identity, job, {
          outcome: 'TECHNICAL_INCOMPLETE',
          reason: 'worker_failed',
        });
      } else {
        await this.releaseIfFinalAttempt(job, identity);
      }
      throw error;
    } finally {
      this.metrics.recordStageDuration(
        'end_to_end',
        Math.max(0, performance.now() - processingStartedAt),
      );
    }
    if (!isCommercialOcrProcessResult(result)) {
      this.metrics.recordCounter('bullmq.job.invalid');
      await this.releaseAdmission(identity, job, {
        outcome: 'TECHNICAL_INCOMPLETE',
        reason: 'invalid_job',
      });
      throw new UnrecoverableError('Commercial OCR moderation returned an invalid result');
    }

    if (result.kind === 'completed') {
      this.metrics.recordCounter('bullmq.job.completed');
      await this.releaseAdmission(
        identity,
        job,
        result.terminal ?? { outcome: 'LEGITIMATE_SKIP', reason: 'policy_ineligible' },
      );
      return;
    }
    if (deadlineAtMs <= Date.now()) {
      this.metrics.recordCounter('bullmq.job.expired');
      await this.releaseAdmission(identity, job, { outcome: 'EXPIRED', reason: 'expired' });
      return;
    }
    if (result.kind === 'retry') {
      this.metrics.recordCounter(`bullmq.job.retry.${result.reason}`);
      const attempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
      const delayMs = Math.max(
        COMMERCIAL_OCR_JOB_BACKOFF_MS * 2 ** job.attemptsMade,
        result.retryAfterMs ?? 0,
      );
      if (job.attemptsMade + 1 < attempts && Date.now() + delayMs >= deadlineAtMs) {
        await this.releaseAdmission(identity, job, { outcome: 'EXPIRED', reason: result.reason });
        throw new UnrecoverableError(`Commercial OCR retry deadline exhausted: ${result.reason}`);
      }
      if (
        result.reason === 'source_unavailable' &&
        result.retryAfterMs &&
        job.attemptsMade + 1 < attempts
      ) {
        // FLAG: Retry-After is a not-before boundary, never a new attempt budget/deadline. Throwing
        // below consumes the normal BullMQ attempt; a later scheduling defer performs no source read.
        await job.updateData({ ...job.data, sourceRetryNotBeforeAt: Date.now() + delayMs });
      }
      await this.releaseIfFinalAttempt(job, identity, result.reason);
      throw new Error(`Commercial OCR transient failure: ${result.reason}`);
    }

    this.metrics.recordCounter(`bullmq.job.defer.${result.reason}`);
    await this.deferWithoutConsumingAttempt(job, token, identity, result, deadlineAtMs);
  }

  private validateJobIdentity(job: Job<CommercialOcrJob>): CommercialOcrJobIdentity {
    const data = job.data;
    if (!isSupportedCommercialOcrJobSchemaVersion(data.schemaVersion)) {
      throw new Error('Commercial OCR job schema version is invalid');
    }
    const expectedJobId = buildCommercialOcrJobId({
      chatId: data.chatId,
      messageId: data.messageId,
      sourceCreatedAt: data.sourceCreatedAt,
      ocrVersion: data.ocrVersion,
      schemaVersion: data.schemaVersion,
      commercialScanRequested: data.commercialScanRequested,
      imageTextScanRequested: data.imageTextScanRequested,
    });
    if (job.id !== expectedJobId || data.idempotencyKey !== expectedJobId) {
      throw new Error('Commercial OCR job identity is invalid');
    }
    return { jobId: expectedJobId, chatId: data.chatId };
  }

  private validateJobEnvelope(job: Job<CommercialOcrJob>): void {
    const data = job.data;
    if (job.name !== COMMERCIAL_OCR_JOB_NAME) {
      throw new Error('Commercial OCR job name is invalid');
    }
    resolveCommercialOcrJobEventTimestamp(data);
    validateCommercialOcrImageCount(data.imageCount);
    const jobOcrVersion = validateCommercialOcrVersion(data.ocrVersion);
    if (jobOcrVersion !== COMMERCIAL_OCR_DEFAULT_VERSION) {
      throw new Error('Commercial OCR job version is stale');
    }
    const validPurposeEnvelope =
      data.schemaVersion === COMMERCIAL_OCR_LEGACY_JOB_SCHEMA_VERSION
        ? data.commercialScanRequested === undefined && data.imageTextScanRequested === undefined
        : typeof data.commercialScanRequested === 'boolean' &&
          typeof data.imageTextScanRequested === 'boolean' &&
          (data.commercialScanRequested || data.imageTextScanRequested);
    if (
      typeof data.webhookEventId !== 'string' ||
      !data.webhookEventId.trim() ||
      data.webhookEventId.length > 512 ||
      typeof data.actionEligible !== 'boolean' ||
      !validPurposeEnvelope ||
      data.sourceTag !== 'commercial-image-ocr' ||
      !isValidTimestamp(data.createdAt) ||
      (data.sourceRetryNotBeforeAt !== undefined &&
        (!Number.isSafeInteger(data.sourceRetryNotBeforeAt) ||
          data.sourceRetryNotBeforeAt <= 0 ||
          data.sourceRetryNotBeforeAt >
            Date.parse(resolveCommercialOcrJobEventTimestamp(data)) + this.maxJobAgeMs))
    ) {
      throw new Error('Commercial OCR job envelope is invalid');
    }
  }

  private async deferWithoutConsumingAttempt(
    job: Job<CommercialOcrJob>,
    token: string | undefined,
    identity: CommercialOcrJobIdentity,
    result: CommercialOcrDeferResult,
    deadlineAtMs: number,
  ): Promise<void> {
    if (!token) {
      await this.releaseIfFinalAttempt(job, identity);
      throw new Error(`Commercial OCR job deferred without a lock token: ${result.reason}`);
    }
    const deferUntilMs = Date.now() + result.delayMs;
    if (deferUntilMs >= deadlineAtMs) {
      this.metrics.recordCounter(`bullmq.job.deadline_exhausted.${result.reason}`);
      await this.releaseAdmission(identity, job, { outcome: 'EXPIRED', reason: result.reason });
      // FLAG: Governor-denied heavy work remains fail-open and terminal. Returning only prevents
      // the controlled expiry from entering BullMQ failed retention after admission is tombstoned.
      if (result.reason === 'governor_pressure' || result.reason === 'native_backpressure') {
        return;
      }
      throw new UnrecoverableError(`Commercial OCR job deadline exhausted: ${result.reason}`);
    }
    try {
      await job.moveToDelayed(deferUntilMs, token);
      this.metrics.recordStageDuration(
        result.reason === 'source_not_ready'
          ? 'source_wait'
          : result.reason === 'native_backpressure'
            ? 'native_wait'
            : 'governor_wait',
        result.delayMs,
      );
    } catch (error: unknown) {
      await this.releaseIfFinalAttempt(job, identity);
      throw new Error(`Commercial OCR job defer failed: ${result.reason}`, { cause: error });
    }
    throw new DelayedError();
  }

  private async releaseIfFinalAttempt(
    job: Job<CommercialOcrJob>,
    identity: CommercialOcrJobIdentity,
    reason: CommercialOcrTerminalResult['reason'] = 'worker_failed',
  ): Promise<void> {
    const attempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
    if (job.attemptsMade + 1 >= attempts) {
      await this.releaseAdmission(identity, job, { outcome: 'TECHNICAL_INCOMPLETE', reason });
    }
  }

  private recordTerminalDuration(job: Job<CommercialOcrJob>): void {
    const eventAtMs = Date.parse(resolveCommercialOcrJobEventTimestamp(job.data));
    this.metrics.recordStageDuration('event_to_terminal', Math.max(0, Date.now() - eventAtMs));
  }

  private async recordLogicalStarted(
    job: Job<CommercialOcrJob>,
    identity: CommercialOcrJobIdentity,
  ): Promise<void> {
    const result = await this.admissionStore
      .recordStarted({
        ...identity,
        context: this.metrics.getLogicalRecordingContext(job.data, identity.jobId),
      })
      .catch(() => 'unavailable' as const);
    this.metrics.observeLogicalRecording(result);
  }

  private async releaseAdmission(
    identity: CommercialOcrJobIdentity,
    job: Job<CommercialOcrJob>,
    terminal: CommercialOcrTerminalResult,
  ): Promise<void> {
    const result = await this.admissionStore
      .finalize({
        ...identity,
        terminal,
        context: this.metrics.getLogicalRecordingContext(job.data, identity.jobId),
      })
      .catch(() => 'unavailable' as const);
    this.metrics.observeLogicalRecording(result, terminal);
    if (result === 'recorded') {
      try {
        this.recordTerminalDuration(job);
      } catch {
        /* Invalid envelopes have no event duration. */
      }
      if (terminal.outcome === 'TECHNICAL_INCOMPLETE' || terminal.outcome === 'EXPIRED') {
        await this.moderationService
          .recordTechnicalIncomplete(job.data, identity.jobId, terminal.reason)
          .catch(() => undefined);
      }
    }

    const released = await this.admissionStore.release(identity).catch(() => false);
    if (!released) {
      this.logger.warn(
        'Commercial OCR admission release failed; expiry cleanup remains authoritative',
      );
    }
  }
}

function isCommercialOcrProcessResult(
  value: unknown,
): value is
  | { kind: 'completed'; terminal?: CommercialOcrTerminalResult }
  | CommercialOcrRetryResult
  | CommercialOcrDeferResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (result.kind === 'completed') {
    return result.terminal === undefined || isCommercialOcrTerminalResult(result.terminal);
  }
  if (
    result.kind === 'retry' &&
    RETRY_REASONS.has(result.reason as CommercialOcrRetryResult['reason']) &&
    (result.retryAfterMs === undefined ||
      (Number.isSafeInteger(result.retryAfterMs) &&
        Number(result.retryAfterMs) >= 1 &&
        Number(result.retryAfterMs) <= MAX_DEFER_MS))
  ) {
    return true;
  }
  return (
    result.kind === 'defer' &&
    Number.isSafeInteger(result.delayMs) &&
    (result.delayMs as number) >= 1 &&
    (result.delayMs as number) <= MAX_DEFER_MS &&
    DEFER_REASONS.has(result.reason as CommercialOcrDeferResult['reason'])
  );
}

function isValidTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asUnrecoverableError(error: unknown, fallbackMessage: string): UnrecoverableError {
  if (error instanceof UnrecoverableError) {
    return error;
  }
  return new UnrecoverableError(error instanceof Error ? error.message : fallbackMessage);
}

function resolveAlbumImageCountMetric(
  imageCount: number,
):
  | 'album.image_count.1'
  | 'album.image_count.2_3'
  | 'album.image_count.4_6'
  | 'album.image_count.7_10' {
  if (imageCount === 1) return 'album.image_count.1';
  if (imageCount <= 3) return 'album.image_count.2_3';
  if (imageCount <= 6) return 'album.image_count.4_6';
  return 'album.image_count.7_10';
}
