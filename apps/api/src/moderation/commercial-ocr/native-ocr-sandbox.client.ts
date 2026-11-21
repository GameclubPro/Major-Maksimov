import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';

import {
  commercialOcrCompleteNativeBehaviorIdentitySchema,
  resolveExpectedCommercialOcrProductionBehaviorIdentity,
  type CommercialOcrNativeArtifactVerification,
  type CommercialOcrNativeBehaviorIdentity,
} from './commercial-ocr-behavior-identity';
import type {
  CommercialOcrPreparedImage,
  CommercialOcrPreprocessOptions,
  CommercialOcrPassName,
} from './commercial-ocr-preprocess-config';
import {
  decodeNativeOcrSandboxFrame,
  encodeNativeOcrSandboxFrame,
  inspectNativeOcrSandboxDeclaredFrameBytes,
  NATIVE_OCR_SANDBOX_FRAME_KINDS,
  NATIVE_OCR_SANDBOX_HEADER_BYTES,
  NATIVE_OCR_SANDBOX_IPC_GRACE_MS,
  NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES,
  NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES,
  NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
  NATIVE_OCR_SANDBOX_MAX_RESPONSE_METADATA_BYTES,
  NATIVE_OCR_SANDBOX_MAX_SOURCE_IMAGE_BYTES,
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
  resolveNativeOcrSandboxSocketPath,
  type NativeOcrSandboxFrame,
  type NativeOcrSandboxFrameKind,
} from './native-ocr-sandbox.protocol';
import type { NativeTesseractRunResult } from './native-tesseract-runner';
import {
  NATIVE_TESSERACT_MAX_LINES,
  NATIVE_TESSERACT_MAX_TEXT_LENGTH,
  NATIVE_TESSERACT_MAX_WORD_LENGTH,
  NATIVE_TESSERACT_MAX_WORDS,
} from './native-tesseract-tsv';
import type { NativeTesseractPageSegmentationMode } from './native-tesseract-ocr.types';
import {
  createNativeOcrSandboxDeadline,
  remainingNativeOcrSandboxTimeoutMs,
} from './native-ocr-sandbox.deadline';
import { assertNativeOcrSandboxSharedClock } from './native-ocr-sandbox.clock';
import {
  isNativeOcrSandboxRequestFailureReason,
  parseNativeOcrSandboxRuntimeStatus,
  type NativeOcrSandboxRequestFailureReason,
  type NativeOcrSandboxRuntimeStatus,
} from './native-ocr-sandbox.runtime';

const PROBE_TIMEOUT_MS = 6_000;
const BOUNDARY_VERIFICATION_FRESHNESS_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const REQUIRED_BOUNDARY_ATTESTATION = Object.freeze({
  transport: 'unix_socket',
  network: 'none',
  environment: 'allowlist',
  processGroupTeardown: 'verified_or_cgroup_recycle',
} as const);

export interface NativeOcrSandboxConfigReader {
  get(propertyPath: string): unknown;
}

export type NativeOcrSandboxBoundaryStatus = Readonly<{
  kind: 'unix_socket_sandbox' | 'local_worker';
  required: boolean;
  configured: boolean;
  verified: boolean;
  activeRequests: number;
  restarts: number;
  runtimeStatus: NativeOcrSandboxRuntimeStatus | null;
  runtimeStatusObservedAtMs: number | null;
}>;

export class NativeOcrSandboxUnavailableError extends Error {
  constructor(readonly reason: 'unconfigured' | 'unverified' | 'unavailable' | 'invalid_response') {
    super(`Native OCR sandbox is ${reason}`);
    this.name = 'NativeOcrSandboxUnavailableError';
  }
}

export class NativeOcrSandboxImageRejectedError extends Error {
  constructor(
    readonly reason: 'invalid_image' | 'too_many_pixels' | 'animated_image' | 'processing_timeout',
  ) {
    super(`Native OCR sandbox rejected image: ${reason}`);
    this.name = 'NativeOcrSandboxImageRejectedError';
  }
}

export class NativeOcrSandboxRequestError extends Error {
  constructor(readonly reason: NativeOcrSandboxRequestFailureReason) {
    super(`Native OCR sandbox request rejected: ${reason}`);
    this.name = 'NativeOcrSandboxRequestError';
  }
}

export class NativeOcrSandboxRequestTimeoutError extends Error {
  constructor() {
    super('Native OCR sandbox request completion was not confirmed before its deadline');
    this.name = 'NativeOcrSandboxRequestTimeoutError';
  }
}

export class NativeOcrSandboxClient {
  private readonly socketPath: string | null;
  private readonly required: boolean;
  private readonly expectedFingerprintSha256: string;
  private readonly expectedIdentity: CommercialOcrNativeBehaviorIdentity;
  private readonly maxSourceImageBytes: number;
  private readonly maxPreparedImageBytes: number;
  private readonly maxOutputBytes: number;
  private readonly sockets = new Set<Socket>();
  private readonly operationSockets = new Set<Socket>();
  private runtimeStatus: NativeOcrSandboxRuntimeStatus | null = null;
  private runtimeStatusObservedAtMs: number | null = null;
  private verified = false;
  private verifiedAtMs = 0;
  private sandboxInstanceId: string | null = null;
  private sandboxRestartCount = 0;
  private shuttingDown = false;
  private probePromise: Promise<CommercialOcrNativeArtifactVerification> | null = null;

  constructor(private readonly config: NativeOcrSandboxConfigReader) {
    const runtimeNodeEnv = config.get('NODE_ENV') ?? process.env.NODE_ENV;
    const configuredPath =
      config.get(NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV) ??
      process.env[NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV];
    this.socketPath = resolveNativeOcrSandboxSocketPath(configuredPath, {
      requireRuntimeDirectory: configuredPath !== undefined && runtimeNodeEnv === 'production',
    });
    this.required =
      config.get('APP_SERVICE_NAME') === 'api-media-analysis' && runtimeNodeEnv === 'production';
    this.expectedIdentity = resolveExpectedCommercialOcrProductionBehaviorIdentity(config).identity;
    this.expectedFingerprintSha256 = this.expectedIdentity.fingerprintSha256;
    this.maxSourceImageBytes = Math.min(
      this.expectedIdentity.manifest.controls.maxSourceImageBytes,
      NATIVE_OCR_SANDBOX_MAX_SOURCE_IMAGE_BYTES,
    );
    this.maxPreparedImageBytes = Math.min(
      this.expectedIdentity.manifest.controls.maxImageBytes,
      NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES,
    );
    this.maxOutputBytes = this.expectedIdentity.manifest.controls.maxOutputBytes;
  }

  isConfigured(): boolean {
    return this.socketPath !== null;
  }

  isRequired(): boolean {
    return this.required;
  }

  isVerified(): boolean {
    const ageMs = Date.now() - this.verifiedAtMs;
    return (
      this.verified &&
      !this.shuttingDown &&
      ageMs >= 0 &&
      ageMs <= BOUNDARY_VERIFICATION_FRESHNESS_MS
    );
  }

  invalidateVerification(): void {
    this.verified = false;
    this.verifiedAtMs = 0;
  }

  getStatus(): NativeOcrSandboxBoundaryStatus {
    return Object.freeze({
      kind: this.socketPath ? 'unix_socket_sandbox' : 'local_worker',
      required: this.required,
      configured: this.socketPath !== null,
      verified: this.isVerified(),
      activeRequests: this.operationSockets.size,
      restarts: this.sandboxRestartCount,
      runtimeStatus: this.isVerified() ? this.runtimeStatus : null,
      runtimeStatusObservedAtMs: this.isVerified() ? this.runtimeStatusObservedAtMs : null,
    });
  }

  async probe(): Promise<CommercialOcrNativeArtifactVerification> {
    if (this.probePromise) {
      return this.probePromise;
    }
    const operation = this.probeOnce().finally(() => {
      if (this.probePromise === operation) {
        this.probePromise = null;
      }
    });
    this.probePromise = operation;
    return operation;
  }

  async preprocess(
    image: Buffer,
    pass: CommercialOcrPassName,
    timeoutMs: number,
    options: Readonly<CommercialOcrPreprocessOptions> = {},
  ): Promise<CommercialOcrPreparedImage> {
    requireImage(image, this.maxSourceImageBytes);
    const boundedTimeoutMs = requireTimeout(timeoutMs, 1, 5_000);
    const response = await this.request({
      requestKind: NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest,
      responseKind: NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse,
      metadata: {
        pass,
        timeoutMs: boundedTimeoutMs,
        ...(options.crop ? { crop: options.crop } : {}),
      },
      payload: image,
      requestPayloadBytes: this.maxSourceImageBytes,
      timeoutMs: boundedTimeoutMs + NATIVE_OCR_SANDBOX_IPC_GRACE_MS,
      deadlineAtMs: options.deadlineAtMs,
      responseMetadataBytes: NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
      responsePayloadBytes: this.maxPreparedImageBytes,
    });
    this.acceptBoundary(response.metadata);
    this.rejectRequestFailure(response.metadata);
    if (response.metadata.status === 'error' && isImageRejectionReason(response.metadata.reason)) {
      throw new NativeOcrSandboxImageRejectedError(response.metadata.reason);
    }
    if (response.metadata.status !== 'ok') {
      throw new NativeOcrSandboxUnavailableError('unavailable');
    }
    const width = response.metadata.width;
    const height = response.metadata.height;
    if (
      !Number.isSafeInteger(width) ||
      (width as number) < 1 ||
      !Number.isSafeInteger(height) ||
      (height as number) < 1 ||
      response.payload.byteLength < 1 ||
      (options.crop && (width !== options.crop.width || height !== options.crop.height))
    ) {
      this.verified = false;
      this.verifiedAtMs = 0;
      throw new NativeOcrSandboxUnavailableError('invalid_response');
    }
    return {
      bytes: Buffer.from(response.payload),
      width: width as number,
      height: height as number,
    };
  }

  async recognize(
    image: Buffer,
    psm: NativeTesseractPageSegmentationMode,
    timeoutMs: number,
    options: Readonly<{ deadlineAtMs?: number }> = {},
  ): Promise<NativeTesseractRunResult> {
    requireImage(image, this.maxPreparedImageBytes);
    if (psm !== 6 && psm !== 11) {
      throw new NativeOcrSandboxUnavailableError('invalid_response');
    }
    const boundedTimeoutMs = requireTimeout(timeoutMs, 1, 60_000);
    const response = await this.request({
      requestKind: NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeRequest,
      responseKind: NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeResponse,
      metadata: { psm, timeoutMs: boundedTimeoutMs },
      payload: image,
      requestPayloadBytes: this.maxPreparedImageBytes,
      timeoutMs: boundedTimeoutMs + NATIVE_OCR_SANDBOX_IPC_GRACE_MS,
      deadlineAtMs: options.deadlineAtMs,
      responseMetadataBytes: Math.min(
        NATIVE_OCR_SANDBOX_MAX_RESPONSE_METADATA_BYTES,
        this.maxOutputBytes + 64 * 1024,
      ),
      responsePayloadBytes: 0,
    });
    this.acceptBoundary(response.metadata);
    this.rejectRequestFailure(response.metadata);
    const result = response.metadata.result;
    if (!isNativeTesseractRunResult(result)) {
      this.verified = false;
      this.verifiedAtMs = 0;
      throw new NativeOcrSandboxUnavailableError('invalid_response');
    }
    return result;
  }

  close(): void {
    this.shuttingDown = true;
    this.verified = false;
    this.verifiedAtMs = 0;
    for (const socket of this.sockets) {
      socket.destroy(new NativeOcrSandboxUnavailableError('unavailable'));
    }
    this.sockets.clear();
    this.operationSockets.clear();
    this.runtimeStatus = null;
    this.runtimeStatusObservedAtMs = null;
  }

  private async probeOnce(): Promise<CommercialOcrNativeArtifactVerification> {
    const response = await this.request({
      requestKind: NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest,
      responseKind: NATIVE_OCR_SANDBOX_FRAME_KINDS.probeResponse,
      metadata: {},
      payload: Buffer.alloc(0),
      requestPayloadBytes: 0,
      timeoutMs: PROBE_TIMEOUT_MS,
      responseMetadataBytes: 64 * 1024,
      responsePayloadBytes: 0,
    });
    this.acceptBoundary(response.metadata);
    const parsedIdentity = commercialOcrCompleteNativeBehaviorIdentitySchema.safeParse(
      response.metadata.identity,
    );
    if (
      response.metadata.status !== 'ok' ||
      !parsedIdentity.success ||
      parsedIdentity.data.fingerprintSha256 !== this.expectedFingerprintSha256
    ) {
      this.verified = false;
      this.verifiedAtMs = 0;
      throw new NativeOcrSandboxUnavailableError('unverified');
    }
    return Object.freeze({
      verified: true,
      status: 'verified',
      mismatches: Object.freeze([]),
      identity: this.expectedIdentity,
    });
  }

  private acceptBoundary(metadata: Readonly<Record<string, unknown>>): void {
    const boundary = metadata.boundary;
    if (
      metadata.fingerprintSha256 !== this.expectedFingerprintSha256 ||
      !isRequiredBoundaryAttestation(boundary)
    ) {
      this.verified = false;
      this.verifiedAtMs = 0;
      throw new NativeOcrSandboxUnavailableError('unverified');
    }
    const instanceId = (boundary as Record<string, unknown>).instanceId as string;
    const runtimeStatus = parseNativeOcrSandboxRuntimeStatus(metadata.runtimeStatus);
    if (metadata.runtimeStatus !== undefined && runtimeStatus === null) {
      this.verified = false;
      this.verifiedAtMs = 0;
      throw new NativeOcrSandboxUnavailableError('invalid_response');
    }
    if (this.sandboxInstanceId !== null && this.sandboxInstanceId !== instanceId) {
      this.sandboxRestartCount += 1;
    }
    this.sandboxInstanceId = instanceId;
    this.verified = true;
    this.verifiedAtMs = Date.now();
    this.runtimeStatus = runtimeStatus;
    this.runtimeStatusObservedAtMs = runtimeStatus === null ? null : this.verifiedAtMs;
  }

  private rejectRequestFailure(metadata: Readonly<Record<string, unknown>>): void {
    if (metadata.status === 'error' && isNativeOcrSandboxRequestFailureReason(metadata.reason)) {
      throw new NativeOcrSandboxRequestError(metadata.reason);
    }
  }

  private async request(params: {
    requestKind: NativeOcrSandboxFrameKind;
    responseKind: NativeOcrSandboxFrameKind;
    metadata: Readonly<Record<string, unknown>>;
    payload: Buffer;
    requestPayloadBytes: number;
    timeoutMs: number;
    deadlineAtMs?: number;
    responseMetadataBytes: number;
    responsePayloadBytes: number;
  }): Promise<NativeOcrSandboxFrame> {
    if (this.shuttingDown) {
      throw new NativeOcrSandboxUnavailableError('unavailable');
    }
    if (!this.socketPath) {
      throw new NativeOcrSandboxUnavailableError('unconfigured');
    }
    try {
      assertNativeOcrSandboxSharedClock();
    } catch {
      this.verified = false;
      this.verifiedAtMs = 0;
      throw new NativeOcrSandboxUnavailableError('unverified');
    }
    if (params.deadlineAtMs !== undefined && !Number.isSafeInteger(params.deadlineAtMs)) {
      throw new NativeOcrSandboxRequestError('invalid_input');
    }
    const totalBudgetMs =
      params.deadlineAtMs === undefined
        ? params.timeoutMs
        : Math.min(params.timeoutMs, params.deadlineAtMs - Date.now());
    if (totalBudgetMs < 1) throw new NativeOcrSandboxRequestError('request_deadline_exceeded');
    const deadlineNs = createNativeOcrSandboxDeadline(totalBudgetMs);
    const request = encodeNativeOcrSandboxFrame({
      kind: params.requestKind,
      metadata:
        params.requestKind === NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest
          ? params.metadata
          : { ...params.metadata, deadlineNs: deadlineNs.toString() },
      payload: params.payload,
      limits: {
        metadataBytes: NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
        payloadBytes: params.requestPayloadBytes,
      },
    });

    try {
      const socketStat = await waitForBoundedOperation(
        lstat(this.socketPath),
        remainingTimeoutMs(deadlineNs),
      );
      const currentUserId = process.getuid?.();
      if (
        !socketStat.isSocket() ||
        currentUserId === undefined ||
        socketStat.uid !== currentUserId ||
        socketStat.nlink !== 1 ||
        (socketStat.mode & 0o777) !== 0o600
      ) {
        throw new NativeOcrSandboxUnavailableError('unverified');
      }
      const responseBytes = await this.exchange(
        request,
        remainingTimeoutMs(deadlineNs),
        {
          metadataBytes: params.responseMetadataBytes,
          payloadBytes: params.responsePayloadBytes,
        },
        params.requestKind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest,
      );
      let response: NativeOcrSandboxFrame;
      try {
        response = decodeNativeOcrSandboxFrame(responseBytes, {
          metadataBytes: params.responseMetadataBytes,
          payloadBytes: params.responsePayloadBytes,
        });
      } catch {
        // FLAG: A malformed sandbox response must not authorize a transport recovery retry.
        throw new NativeOcrSandboxUnavailableError('invalid_response');
      }
      remainingTimeoutMs(deadlineNs);
      if (response.kind !== params.responseKind) {
        throw new NativeOcrSandboxUnavailableError('invalid_response');
      }
      return response;
    } catch (error: unknown) {
      this.verified = false;
      this.verifiedAtMs = 0;
      if (
        (error instanceof NativeOcrSandboxRequestError ||
          error instanceof NativeOcrSandboxRequestTimeoutError) &&
        params.requestKind === NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest
      ) {
        throw new NativeOcrSandboxUnavailableError('unavailable');
      }
      if (
        error instanceof NativeOcrSandboxUnavailableError ||
        error instanceof NativeOcrSandboxRequestError ||
        error instanceof NativeOcrSandboxRequestTimeoutError
      ) {
        throw error;
      }
      throw new NativeOcrSandboxUnavailableError('unavailable');
    } finally {
      request.fill(0);
    }
  }

  private exchange(
    request: Buffer,
    timeoutMs: number,
    limits: Readonly<{ metadataBytes: number; payloadBytes: number }>,
    operationRequest: boolean,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath! });
      this.sockets.add(socket);
      if (operationRequest) this.operationSockets.add(socket);
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let declaredBytes: number | null = null;
      let settled = false;
      const maximumBytes = Math.min(
        NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES,
        NATIVE_OCR_SANDBOX_HEADER_BYTES + limits.metadataBytes + limits.payloadBytes,
      );
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.sockets.delete(socket);
        this.operationSockets.delete(socket);
        socket.removeAllListeners();
        socket.destroy();
        request.fill(0);
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.concat(chunks, receivedBytes));
      };
      const timeout = setTimeout(
        // FLAG: No server response proves this operation stayed out of native execution.
        // Never treat a local watchdog expiry as a retryable queue rejection.
        () => finish(new NativeOcrSandboxRequestTimeoutError()),
        timeoutMs,
      );
      timeout.unref();
      socket.once('connect', () => {
        socket.write(request, () => request.fill(0));
      });
      socket.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > maximumBytes) {
          finish(new NativeOcrSandboxUnavailableError('invalid_response'));
          return;
        }
        chunks.push(Buffer.from(chunk));
        if (declaredBytes === null && receivedBytes >= NATIVE_OCR_SANDBOX_HEADER_BYTES) {
          try {
            declaredBytes = inspectNativeOcrSandboxDeclaredFrameBytes(
              Buffer.concat(chunks, receivedBytes).subarray(0, NATIVE_OCR_SANDBOX_HEADER_BYTES),
            );
            if (declaredBytes > maximumBytes) {
              finish(new NativeOcrSandboxUnavailableError('invalid_response'));
              return;
            }
          } catch {
            finish(new NativeOcrSandboxUnavailableError('invalid_response'));
          }
        }
        if (declaredBytes !== null) {
          if (receivedBytes > declaredBytes) {
            finish(new NativeOcrSandboxUnavailableError('invalid_response'));
          } else if (receivedBytes === declaredBytes) {
            finish();
          }
        }
      });
      socket.once('end', () => {
        finish(new NativeOcrSandboxUnavailableError('invalid_response'));
      });
      socket.once('error', () => finish(new NativeOcrSandboxUnavailableError('unavailable')));
    });
  }
}

function remainingTimeoutMs(deadlineNs: bigint): number {
  const remaining = remainingNativeOcrSandboxTimeoutMs(deadlineNs);
  if (remaining < 1) {
    throw new NativeOcrSandboxRequestTimeoutError();
  }
  return remaining;
}

function waitForBoundedOperation<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new NativeOcrSandboxRequestTimeoutError())),
      timeoutMs,
    );
    timeout.unref();
    operation.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new NativeOcrSandboxUnavailableError('unavailable'))),
    );
  });
}

function isRequiredBoundaryAttestation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.entries(REQUIRED_BOUNDARY_ATTESTATION).every(
      ([key, expected]) => candidate[key] === expected,
    ) &&
    typeof candidate.instanceId === 'string' &&
    UUID_PATTERN.test(candidate.instanceId)
  );
}

function isNativeTesseractRunResult(value: unknown): value is NativeTesseractRunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === false) {
    return (
      candidate.reason === 'timeout' ||
      candidate.reason === 'tesseract_failed' ||
      candidate.reason === 'output_limit' ||
      candidate.reason === 'invalid_output'
    );
  }
  if (candidate.ok !== true || !candidate.payload || typeof candidate.payload !== 'object') {
    return false;
  }
  const payload = candidate.payload as Record<string, unknown>;
  return (
    typeof payload.text === 'string' &&
    payload.text.length <= NATIVE_TESSERACT_MAX_TEXT_LENGTH &&
    (payload.aggregateConfidence === null || isConfidence(payload.aggregateConfidence)) &&
    Array.isArray(payload.words) &&
    payload.words.length <= NATIVE_TESSERACT_MAX_WORDS &&
    payload.words.every(isWordSpan) &&
    Array.isArray(payload.lines) &&
    payload.lines.length <= NATIVE_TESSERACT_MAX_LINES &&
    payload.lines.every(isLineSpan) &&
    typeof payload.truncated === 'boolean'
  );
}

function isWordSpan(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.length >= 1 &&
    candidate.text.length <= NATIVE_TESSERACT_MAX_WORD_LENGTH &&
    isNonNegativeInteger(candidate.start) &&
    isNonNegativeInteger(candidate.end) &&
    (candidate.end as number) > (candidate.start as number) &&
    isConfidence(candidate.confidence) &&
    isNonNegativeInteger(candidate.lineIndex) &&
    isBoundingBox(candidate.boundingBox)
  );
}

function isLineSpan(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.length >= 1 &&
    candidate.text.length <= NATIVE_TESSERACT_MAX_TEXT_LENGTH &&
    isNonNegativeInteger(candidate.start) &&
    isNonNegativeInteger(candidate.end) &&
    (candidate.end as number) > (candidate.start as number) &&
    isConfidence(candidate.confidence) &&
    isNonNegativeInteger(candidate.wordStartIndex) &&
    isNonNegativeInteger(candidate.wordEndIndex) &&
    (candidate.wordEndIndex as number) >= (candidate.wordStartIndex as number) &&
    isBoundingBox(candidate.boundingBox)
  );
}

function isBoundingBox(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonNegativeInteger(candidate.left) &&
    isNonNegativeInteger(candidate.top) &&
    isNonNegativeInteger(candidate.width) &&
    (candidate.width as number) > 0 &&
    isNonNegativeInteger(candidate.height) &&
    (candidate.height as number) > 0
  );
}

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function requireImage(image: Buffer, maximumBytes: number): void {
  if (!Buffer.isBuffer(image) || image.byteLength < 1 || image.byteLength > maximumBytes) {
    throw new NativeOcrSandboxUnavailableError('invalid_response');
  }
}

function requireTimeout(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new NativeOcrSandboxUnavailableError('invalid_response');
  }
  return value;
}

function isImageRejectionReason(
  value: unknown,
): value is NativeOcrSandboxImageRejectedError['reason'] {
  return (
    value === 'invalid_image' ||
    value === 'too_many_pixels' ||
    value === 'animated_image' ||
    value === 'processing_timeout'
  );
}
