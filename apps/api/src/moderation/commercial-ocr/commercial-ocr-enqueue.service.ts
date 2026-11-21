import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CommercialOcrAdmissionStore,
  type CommercialOcrAdmissionActivationResult,
  type CommercialOcrAdmissionResult,
  type CommercialOcrAdmissionSuppressionResult,
} from './commercial-ocr-admission.store';
import { resolveCommercialOcrReservationTtlMs } from './commercial-ocr-admission.config';
import {
  CommercialOcrMetricsService,
  type CommercialOcrMetricCounter,
} from './commercial-ocr-metrics.service';
import { CommercialOcrQueueProducer } from './commercial-ocr-queue.producer';
import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_DEFAULT_VERSION,
  COMMERCIAL_OCR_JOB_NAME,
  COMMERCIAL_OCR_JOB_OPTIONS,
  COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
  normalizeCommercialOcrActionEligibility,
  normalizeImageTextScanRequested,
  validateCommercialOcrImageCount,
} from './commercial-ocr.queue';
import {
  resolveCommercialOcrRuntimePolicy,
  type CommercialOcrRolloutMode,
} from './commercial-ocr.runtime';
import { resolveImageTextStopListOcrRuntimePolicy } from './image-text-stop-list.runtime';

const DEFAULT_MAX_GLOBAL_IMAGE_UNITS = 16;
const DEFAULT_MAX_CHAT_IMAGE_UNITS = 10;
const DEFAULT_RESERVED_ACTIONABLE_IMAGE_UNITS = 4;
const DEFAULT_MAX_JOB_AGE_MS = 5 * 60_000;
export type CommercialOcrEnqueueResult = 'queued' | 'skipped' | 'failed';

export type CommercialOcrPendingActivation = Readonly<{
  jobId: string;
  chatId: string;
  imageCount: number;
  reservationTtlMs: number;
}>;

@Injectable()
export class CommercialOcrEnqueueService {
  private readonly logger = new Logger(CommercialOcrEnqueueService.name);

  constructor(
    @Optional() private readonly queue?: CommercialOcrQueueProducer,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly admissionStore?: CommercialOcrAdmissionStore,
    @Optional() private readonly metrics?: CommercialOcrMetricsService,
  ) {}

  async enqueue(params: {
    webhookEventId: string;
    chatId: string;
    messageId: string;
    sourceCreatedAt: string;
    eventTimestamp: string;
    imageCount: number;
    actionEligible: boolean;
    commercialScanRequested?: boolean;
    imageTextScanRequested?: boolean;
    registerPendingActivation?: (
      activation: CommercialOcrPendingActivation,
    ) => void | Promise<void>;
  }): Promise<CommercialOcrEnqueueResult> {
    const runtimePolicy = resolveCommercialOcrRuntimePolicy({
      chatId: params.chatId,
      configService: this.configService,
    });
    const imageTextRuntimePolicy = resolveImageTextStopListOcrRuntimePolicy({
      configService: this.configService,
      // Producer admission is not action authority. The worker verifies the live sandbox again.
      sandboxBoundaryVerified: true,
    });
    const imageTextScanRequested = normalizeImageTextScanRequested(params.imageTextScanRequested);
    const commercialScanRequested = params.commercialScanRequested !== false;
    if (
      !(commercialScanRequested && runtimePolicy.process) &&
      !(imageTextScanRequested && imageTextRuntimePolicy.process)
    ) {
      return this.finishEnqueue('skipped');
    }
    if (!this.queue || !this.admissionStore) {
      return this.finishEnqueue('skipped');
    }

    const imageCount = validateCommercialOcrImageCount(params.imageCount);
    const ocrVersion = COMMERCIAL_OCR_DEFAULT_VERSION;
    const jobId = buildCommercialOcrJobId({
      chatId: params.chatId,
      messageId: params.messageId,
      sourceCreatedAt: params.sourceCreatedAt,
      ocrVersion,
      commercialScanRequested,
      imageTextScanRequested,
    });
    const requestedActionEligible = normalizeCommercialOcrActionEligibility(params.actionEligible);
    const limits = this.resolveAdmissionLimits(runtimePolicy.mode, imageTextRuntimePolicy.enforce);
    if (!requestedActionEligible) {
      const suppression = await this.admissionStore.suppress({
        jobId,
        chatId: params.chatId,
        imageCount,
        tombstoneTtlMs: limits.reservationTtlMs,
      });
      this.recordSuppression(suppression);
      return this.finishEnqueue('skipped');
    }
    const reservation = await this.admissionStore.reserve({
      jobId,
      chatId: params.chatId,
      sourceCreatedAt: params.eventTimestamp,
      imageCount,
      actionEligible:
        requestedActionEligible &&
        ((commercialScanRequested && runtimePolicy.enforce) ||
          (imageTextScanRequested && imageTextRuntimePolicy.enforce)),
      limits,
    });
    this.recordReservation(reservation, imageCount);

    if (reservation.kind === 'unavailable') {
      // The reserve EVAL may have committed after its local timeout. Issuing suppression through
      // the same store connection preserves Redis command order and absorbs that late reservation.
      const suppression = await this.admissionStore
        .suppress({
          jobId,
          chatId: params.chatId,
          imageCount,
          tombstoneTtlMs: limits.reservationTtlMs,
        })
        .catch(() => 'unavailable' as const);
      this.recordSuppression(suppression);
      if (suppression !== 'suppressed') {
        this.logger.warn(
          'Commercial OCR ambiguous admission could not be suppressed; reservation expiry remains authoritative',
        );
      }
      return this.finishEnqueue('failed');
    }
    if (reservation.kind !== 'admitted' && reservation.kind !== 'duplicate') {
      return this.finishEnqueue('skipped');
    }

    // A prior suppression already absorbed this identity. A newly admitted observation is the
    // shadow-mode case and must still be analyzed.
    if (reservation.kind === 'duplicate' && reservation.state === 'observation') {
      return this.finishEnqueue('skipped');
    }
    const actionRequested = reservation.state !== 'observation';

    try {
      const createdAt = new Date().toISOString();
      await this.queue.add(
        COMMERCIAL_OCR_JOB_NAME,
        {
          webhookEventId: params.webhookEventId,
          chatId: params.chatId,
          messageId: params.messageId,
          sourceCreatedAt: params.sourceCreatedAt,
          eventTimestamp: params.eventTimestamp,
          imageCount,
          schemaVersion: COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
          ocrVersion,
          actionEligible: false,
          commercialScanRequested,
          imageTextScanRequested,
          idempotencyKey: jobId,
          sourceTag: 'commercial-image-ocr',
          createdAt,
        },
        { ...COMMERCIAL_OCR_JOB_OPTIONS, jobId },
      );
      if (!actionRequested) {
        return this.finishEnqueue('queued');
      }
      const activation = {
        jobId,
        chatId: params.chatId,
        imageCount,
        reservationTtlMs: limits.reservationTtlMs,
      };
      if (params.registerPendingActivation) {
        await params.registerPendingActivation(activation);
      } else {
        await this.suppressPending(activation);
      }
      return this.finishEnqueue('queued');
    } catch (error: unknown) {
      // A timed-out add may still have created the job before its producer connection was closed.
      // Pending is already fail-open; this tombstone also absorbs any later activation.
      const suppression = await this.admissionStore
        .suppress({
          jobId,
          chatId: params.chatId,
          imageCount,
          tombstoneTtlMs: limits.reservationTtlMs,
        })
        .catch(() => 'unavailable' as const);
      this.recordSuppression(suppression);
      this.logger.warn(
        { failureKind: classifyEnqueueFailure(error) },
        'Failed to enqueue commercial OCR analysis; moderation continues fail-open',
      );
      return this.finishEnqueue('failed');
    }
  }

  async activatePending(activation: CommercialOcrPendingActivation): Promise<boolean> {
    if (!this.admissionStore) {
      return false;
    }
    const result = await this.admissionStore.activate({
      jobId: activation.jobId,
      tombstoneTtlMs: activation.reservationTtlMs,
    });
    this.metrics?.recordCounter(resolveActivationMetric(result));
    if (result === 'activated' || result === 'already_actionable') {
      return true;
    }
    if (result !== 'suppressed') {
      this.logger.warn(
        { result },
        'Commercial OCR activation was not confirmed after webhook completion',
      );
      await this.suppressPending(activation).catch(() => false);
    }
    return false;
  }

  async activatePendingBatch(
    activations: readonly CommercialOcrPendingActivation[],
  ): Promise<void> {
    for (const activation of activations) {
      try {
        await this.activatePending(activation);
      } catch (error: unknown) {
        this.metrics?.recordCounter('admission.activation.unavailable');
        this.logger.warn(
          { failureKind: classifyEnqueueFailure(error) },
          'Commercial OCR activation failed after webhook completion; pending admission remains non-actionable',
        );
      }
    }
  }

  async suppressPending(activation: CommercialOcrPendingActivation): Promise<boolean> {
    if (!this.admissionStore) {
      return false;
    }
    const result = await this.admissionStore.suppress({
      jobId: activation.jobId,
      chatId: activation.chatId,
      imageCount: activation.imageCount,
      tombstoneTtlMs: activation.reservationTtlMs,
    });
    this.recordSuppression(result);
    return result === 'suppressed';
  }

  async suppressPendingBatch(
    activations: readonly CommercialOcrPendingActivation[],
  ): Promise<void> {
    for (const activation of activations) {
      try {
        await this.suppressPending(activation);
      } catch (error: unknown) {
        this.metrics?.recordCounter('admission.suppression.unavailable');
        this.logger.warn(
          { failureKind: classifyEnqueueFailure(error) },
          'Commercial OCR suppression failed after webhook processing failure; pending admission remains non-actionable',
        );
      }
    }
  }

  private resolveAdmissionLimits(
    rolloutMode: CommercialOcrRolloutMode,
    imageTextEnforcementEnabled: boolean,
  ) {
    return {
      maxGlobalImageUnits: this.readPositiveInt(
        'COMMERCIAL_OCR_MAX_GLOBAL_IMAGE_UNITS',
        DEFAULT_MAX_GLOBAL_IMAGE_UNITS,
      ),
      maxChatImageUnits: this.readPositiveInt(
        'COMMERCIAL_OCR_MAX_CHAT_IMAGE_UNITS',
        DEFAULT_MAX_CHAT_IMAGE_UNITS,
      ),
      // Pure shadow traffic remains unchanged. The reserve is activated only when the environment
      // ceiling permits enforcement, and the admission store applies it only to observations.
      reservedActionableImageUnits:
        (rolloutMode === 'off' || rolloutMode === 'shadow') && !imageTextEnforcementEnabled
          ? 0
          : this.readNonNegativeInt(
              'COMMERCIAL_OCR_RESERVED_ACTIONABLE_IMAGE_UNITS',
              DEFAULT_RESERVED_ACTIONABLE_IMAGE_UNITS,
            ),
      maxJobAgeMs: this.readPositiveInt('COMMERCIAL_OCR_MAX_JOB_AGE_MS', DEFAULT_MAX_JOB_AGE_MS),
      reservationTtlMs: resolveCommercialOcrReservationTtlMs(this.configService),
    };
  }

  private recordReservation(result: CommercialOcrAdmissionResult, imageCount: number): void {
    this.metrics?.recordCounter(resolveReservationMetric(result));
    if (
      result.kind === 'admitted' ||
      result.kind === 'rejected_global' ||
      result.kind === 'rejected_chat' ||
      result.kind === 'rejected_actionable_reserve'
    ) {
      this.metrics?.recordCounter(`admission.image_units.${result.kind}`, imageCount);
    }
  }

  private recordSuppression(result: CommercialOcrAdmissionSuppressionResult): void {
    this.metrics?.recordCounter(resolveSuppressionMetric(result));
  }

  private finishEnqueue(result: CommercialOcrEnqueueResult): CommercialOcrEnqueueResult {
    const counters: Record<CommercialOcrEnqueueResult, CommercialOcrMetricCounter> = {
      queued: 'enqueue.queued',
      skipped: 'enqueue.skipped',
      failed: 'enqueue.failed',
    };
    this.metrics?.recordCounter(counters[result]);
    return result;
  }

  private readPositiveInt(key: string, fallback: number): number {
    const value = Number(this.configService?.get(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private readNonNegativeInt(key: string, fallback: number): number {
    const value = Number(this.configService?.get(key));
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }
}

function resolveReservationMetric(
  result: CommercialOcrAdmissionResult,
): CommercialOcrMetricCounter {
  if (result.kind === 'admitted' || result.kind === 'duplicate') {
    return `admission.${result.kind}.${result.state}`;
  }
  const outcomes: Record<
    Exclude<CommercialOcrAdmissionResult['kind'], 'admitted' | 'duplicate'>,
    CommercialOcrMetricCounter
  > = {
    rejected_global: 'admission.rejected.global',
    rejected_actionable_reserve: 'admission.rejected.actionable_reserve',
    rejected_chat: 'admission.rejected.chat',
    rejected_age: 'admission.rejected.age',
    unavailable: 'admission.unavailable',
  };
  return outcomes[result.kind];
}

function resolveSuppressionMetric(
  result: CommercialOcrAdmissionSuppressionResult,
): CommercialOcrMetricCounter {
  return result === 'suppressed'
    ? 'admission.suppression.suppressed'
    : 'admission.suppression.unavailable';
}

function resolveActivationMetric(
  result: CommercialOcrAdmissionActivationResult,
): CommercialOcrMetricCounter {
  const outcomes: Record<CommercialOcrAdmissionActivationResult, CommercialOcrMetricCounter> = {
    activated: 'admission.activation.activated',
    already_actionable: 'admission.activation.already_actionable',
    suppressed: 'admission.activation.suppressed',
    expired: 'admission.activation.expired',
    missing: 'admission.activation.missing',
    unavailable: 'admission.activation.unavailable',
  };
  return outcomes[result];
}

function classifyEnqueueFailure(error: unknown): 'error' | 'unknown' {
  return error instanceof Error ? 'error' : 'unknown';
}
