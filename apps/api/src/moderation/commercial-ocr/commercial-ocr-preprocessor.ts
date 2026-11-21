import { Injectable, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  NativeOcrSandboxImageRejectedError,
  NativeOcrSandboxRequestError,
  NativeOcrSandboxRequestTimeoutError,
  NativeOcrSandboxUnavailableError,
} from './native-ocr-sandbox.client';
import { NativeOcrSandboxPool } from './native-ocr-sandbox.pool';
import {
  COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
  CommercialOcrImageRejectedError,
  resolveCommercialOcrPreprocessLimits,
  type CommercialOcrPassName,
  type CommercialOcrPreparedImage,
  type CommercialOcrPreprocessOptions,
} from './commercial-ocr-preprocess-config';
import { NATIVE_OCR_SANDBOX_IPC_GRACE_MS } from './native-ocr-sandbox.protocol';

const MINIMUM_SHARP_EXECUTION_BUDGET_MS = 1_000;

export {
  COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS,
  COMMERCIAL_OCR_PREPROCESS_PROFILES,
  COMMERCIAL_OCR_SHARP_CONCURRENCY,
  COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
  CommercialOcrImageRejectedError,
  resolveCommercialOcrPreprocessCacheProfile,
  resolveCommercialOcrPreprocessLimits,
  type CommercialOcrPassName,
  type CommercialOcrPreparedImage,
  type CommercialOcrPreprocessOptions,
  type CommercialOcrPreprocessConfigReader,
  type CommercialOcrPreprocessLimits,
} from './commercial-ocr-preprocess-config';

export class CommercialOcrPreprocessUnavailableError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly reason:
      | 'unconfigured'
      | 'unavailable'
      | 'unverified'
      | 'invalid_response'
      | 'capacity_exhausted'
      | 'request_timeout'
      | 'request_deadline_exceeded'
      | 'invalid_input'
      | 'shutting_down' = 'unavailable',
  ) {
    super('Commercial OCR native preprocess boundary is unavailable');
    this.name = 'CommercialOcrPreprocessUnavailableError';
    this.retryable = reason === 'unavailable' || reason === 'shutting_down';
  }
}

@Injectable()
export class CommercialOcrPreprocessor implements OnModuleDestroy {
  private readonly sandbox: NativeOcrSandboxPool;
  private readonly localEnabled: boolean;
  private localPromise: Promise<
    import('./native-ocr-image-preprocessor').NativeOcrImagePreprocessor
  > | null = null;

  constructor(configService: ConfigService, @Optional() sandbox?: NativeOcrSandboxPool) {
    const limits = resolveCommercialOcrPreprocessLimits(configService);
    this.sandbox = sandbox ?? new NativeOcrSandboxPool(configService);
    this.localEnabled = !this.sandbox.isConfigured() && !this.sandbox.isRequired();
    if (this.localEnabled) {
      this.localPromise = import('./native-ocr-image-preprocessor').then(
        ({ NativeOcrImagePreprocessor }) => new NativeOcrImagePreprocessor(limits),
      );
    }
  }

  async prepare(
    input: Buffer,
    pass: CommercialOcrPassName,
    options: CommercialOcrPreprocessOptions = {},
  ): Promise<CommercialOcrPreparedImage> {
    if (this.sandbox.isConfigured()) {
      const timeoutMs = resolveSandboxPreprocessTimeout(options.deadlineAtMs);
      try {
        return await this.sandbox.preprocess(input, pass, timeoutMs, options);
      } catch (error: unknown) {
        if (error instanceof NativeOcrSandboxImageRejectedError) {
          throw new CommercialOcrImageRejectedError(error.reason);
        }
        if (error instanceof NativeOcrSandboxRequestTimeoutError) {
          throw new CommercialOcrPreprocessUnavailableError('request_timeout');
        }
        if (
          error instanceof NativeOcrSandboxUnavailableError ||
          error instanceof NativeOcrSandboxRequestError
        ) {
          throw new CommercialOcrPreprocessUnavailableError(error.reason);
        }
        throw error;
      }
    }
    if (!this.localEnabled || !this.localPromise) {
      throw new CommercialOcrPreprocessUnavailableError('unconfigured');
    }
    return (await this.localPromise).prepare(input, pass, options);
  }

  onModuleDestroy(): void {
    this.sandbox.close();
  }
}

function resolveSandboxPreprocessTimeout(deadlineAtMs: number | undefined): number {
  const localMaximumMs = COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS * 1_000;
  if (deadlineAtMs === undefined) {
    return localMaximumMs;
  }
  if (!Number.isSafeInteger(deadlineAtMs)) {
    throw new CommercialOcrImageRejectedError('processing_timeout');
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= NATIVE_OCR_SANDBOX_IPC_GRACE_MS + MINIMUM_SHARP_EXECUTION_BUDGET_MS) {
    throw new CommercialOcrImageRejectedError('processing_timeout');
  }
  return Math.min(localMaximumMs, remainingMs - NATIVE_OCR_SANDBOX_IPC_GRACE_MS);
}
