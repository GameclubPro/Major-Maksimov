import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  COMMERCIAL_OCR_NATIVE_ORCHESTRATION,
  resolveCommercialOcrNativeEngineConfig,
  resolveCommercialOcrNativeRuntimeControls,
  resolveExpectedCommercialOcrProductionBehaviorIdentity,
  resolveVerifiedCommercialOcrNativeBehaviorIdentity,
  type CommercialOcrNativeArtifactVerification,
  type CommercialOcrNativeBehaviorIdentity,
} from './commercial-ocr-behavior-identity';
import {
  NativeOcrSandboxRequestError,
  NativeOcrSandboxRequestTimeoutError,
  NativeOcrSandboxUnavailableError,
} from './native-ocr-sandbox.client';
import { NativeOcrSandboxPool } from './native-ocr-sandbox.pool';
import {
  NATIVE_TESSERACT_PAGE_SEGMENTATION_MODES,
  type NativeTesseractFailedOpenResult,
  type NativeTesseractFailureReason,
  type NativeTesseractOcrResult,
  type NativeTesseractPageSegmentationMode,
  type NativeTesseractRecognizeOptions,
} from './native-tesseract-ocr.types';
import { NATIVE_OCR_SANDBOX_IPC_GRACE_MS } from './native-ocr-sandbox.protocol';
import type { NativeOcrSandboxRuntimeStatus } from './native-ocr-sandbox.runtime';
import type {
  NativeTesseractWorkerRequest,
  NativeTesseractWorkerResponse,
  NativeTesseractWorkerResultResponse,
} from './native-tesseract-worker.protocol';

const DEFAULT_PSM: NativeTesseractPageSegmentationMode = 11;
const WORKER_RESTART_DELAY_MS = COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerRestartDelayMs;
const WORKER_RETRY_COOLDOWN_MS = COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerRetryCooldownMs;
const WORKER_SHUTDOWN_GRACE_MS = COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerShutdownGraceMs;
const WORKER_FORCE_EXIT_GRACE_MS = COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerForceExitGraceMs;
const WORKER_STARTUP_TIMEOUT_MS = COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerStartupTimeoutMs;
const WORKER_RESULT_GRACE_MS = COMMERCIAL_OCR_NATIVE_ORCHESTRATION.workerResultGraceMs;
const MAX_WORKER_RESTART_ATTEMPTS = COMMERCIAL_OCR_NATIVE_ORCHESTRATION.maxWorkerRestartAttempts;
const QUEUE_WAIT_SAMPLE_CAPACITY = 512;
const SANDBOX_PROBE_INTERVAL_MS = 5_000;

type OcrJob = {
  id: string;
  image: Buffer;
  psm: NativeTesseractPageSegmentationMode;
  passLabel: string;
  startedAt: number;
  enqueuedAt: number;
  deadlineAt: number;
  timer: NodeJS.Timeout;
  settled: boolean;
  resolve: (result: NativeTesseractOcrResult) => void;
};

type WorkerRetirementReason = 'healthy_recycle' | 'failure' | 'shutdown';

type WorkerSlot = {
  id: number;
  generation: number;
  process: ChildProcess | null;
  ready: boolean;
  retirementReason: WorkerRetirementReason | null;
  restartAttempts: number;
  retryAfter: number;
  jobsProcessed: number;
  current: OcrJob | null;
  restartTimer: NodeJS.Timeout | null;
  startupTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
};

export type NativeTesseractRuntimeStatus = Readonly<{
  state: 'starting' | 'ready' | 'degraded' | 'shutting_down';
  ready: boolean;
  workers: Readonly<{ configured: number; live: number; ready: number; busy: number | null }>;
  queueDepth: number | null;
  sandboxRuntime?: Readonly<{
    available: boolean;
    observedAtMs: number | null;
    snapshot: NativeOcrSandboxRuntimeStatus | null;
    lanes?: readonly Readonly<{
      verified: boolean;
      observedAtMs: number | null;
      snapshot: NativeOcrSandboxRuntimeStatus | null;
    }>[];
  }>;
  queueWaitMs: NativeTesseractQueueWaitSnapshot;
  counters: Readonly<{
    completed: number;
    failed: number;
    restarts: number;
    recycles: number;
    failuresByReason: Readonly<Partial<Record<NativeTesseractFailureReason, number>>>;
  }>;
  latencyMs: Readonly<{ last: number | null; average: number | null; maximum: number | null }>;
  behaviorIdentity: NativeTesseractBehaviorIdentityStatus;
  boundary?: Readonly<{
    kind: 'unix_socket_sandbox' | 'local_worker';
    required: boolean;
    verified: boolean;
  }>;
}>;

export type NativeTesseractBehaviorIdentityStatus = Readonly<{
  fingerprintSha256: string;
  runtimeFingerprintSha256: string | null;
  buildManifestSha256: string | null;
  complete: boolean;
  required: boolean;
  verified: boolean;
  state: 'not_required' | 'pending' | 'verified' | 'failed';
  mismatchFields: readonly string[];
}>;

export type NativeTesseractQueueWaitSnapshot = Readonly<{
  observed: number | null;
  sampled: number | null;
  capacity: number;
  last: number | null;
  average: number | null;
  p95: number | null;
  p99: number | null;
  maximum: number | null;
}>;

class BoundedQueueWaitMetric {
  private readonly samples: Array<number | undefined>;
  private nextIndex = 0;
  private sampleCount = 0;
  private observedCount = 0;
  private lastValue: number | null = null;

  constructor(private readonly capacity: number) {
    this.samples = new Array<number | undefined>(capacity);
  }

  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    const rounded = roundDuration(value);
    this.samples[this.nextIndex] = rounded;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.sampleCount = Math.min(this.capacity, this.sampleCount + 1);
    this.observedCount += 1;
    this.lastValue = rounded;
  }

  snapshot(): NativeTesseractQueueWaitSnapshot {
    const values = this.orderedValues().sort((left, right) => left - right);
    if (values.length === 0) {
      return {
        observed: this.observedCount,
        sampled: 0,
        capacity: this.capacity,
        last: null,
        average: null,
        p95: null,
        p99: null,
        maximum: null,
      };
    }
    return {
      observed: this.observedCount,
      sampled: values.length,
      capacity: this.capacity,
      last: this.lastValue,
      average: roundDuration(values.reduce((sum, value) => sum + value, 0) / values.length),
      p95: nearestRank(values, 0.95),
      p99: nearestRank(values, 0.99),
      maximum: values[values.length - 1]!,
    };
  }

  private orderedValues(): number[] {
    if (this.sampleCount < this.capacity) {
      return this.samples.slice(0, this.sampleCount) as number[];
    }
    return [
      ...(this.samples.slice(this.nextIndex) as number[]),
      ...(this.samples.slice(0, this.nextIndex) as number[]),
    ];
  }
}

@Injectable()
export class NativeTesseractOcrAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NativeTesseractOcrAdapter.name);
  private readonly binary: string;
  private readonly tessdataPrefix?: string;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly recycleAfterJobs: number;
  private readonly maxImageBytes: number;
  private readonly maxOutputBytes: number;
  private readonly ompThreadLimit: number;
  private readonly nativeArtifactVerificationRequired: boolean;
  private readonly nativeBehaviorIdentity: CommercialOcrNativeBehaviorIdentity;
  private readonly sandbox: NativeOcrSandboxPool;
  private sandboxProbeTimer: NodeJS.Timeout | null = null;
  private nativeArtifactVerification: CommercialOcrNativeArtifactVerification | null = null;
  private nativeArtifactVerificationPromise: Promise<void> | null = null;
  private nativeArtifactVerificationFailureReason: 'artifact_unverified' | 'worker_unavailable' =
    'artifact_unverified';
  private readonly workerPath = resolveWorkerPath(__dirname);
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: OcrJob[] = [];
  private initialized = false;
  private shuttingDown = false;
  private completedCount = 0;
  private failedCount = 0;
  private restartCount = 0;
  private recycleCount = 0;
  private totalLatencyMs = 0;
  private lastLatencyMs: number | null = null;
  private maxLatencyMs: number | null = null;
  private readonly failuresByReason = new Map<NativeTesseractFailureReason, number>();
  private readonly queueWaitMs = new BoundedQueueWaitMetric(QUEUE_WAIT_SAMPLE_CAPACITY);

  constructor(
    private readonly configService: ConfigService,
    @Optional() sandbox?: NativeOcrSandboxPool,
  ) {
    const engine = resolveCommercialOcrNativeEngineConfig(configService);
    const controls = resolveCommercialOcrNativeRuntimeControls(configService);
    this.binary = engine.binary;
    this.tessdataPrefix = engine.tessdataPrefix ?? undefined;
    this.timeoutMs = controls.timeoutMs;
    this.concurrency = controls.concurrency;
    this.maxQueue = controls.maxQueue;
    this.recycleAfterJobs = controls.recycleAfterJobs;
    this.maxImageBytes = controls.maxImageBytes;
    this.maxOutputBytes = controls.maxOutputBytes;
    this.ompThreadLimit = controls.ompThreadLimit;
    this.nativeArtifactVerificationRequired =
      configService.get<string>('APP_SERVICE_NAME') === 'api-media-analysis';
    this.nativeBehaviorIdentity =
      resolveExpectedCommercialOcrProductionBehaviorIdentity(configService).identity;
    this.sandbox = sandbox ?? new NativeOcrSandboxPool(configService);
  }

  onModuleInit(): void {
    this.startNativeArtifactVerification();
    this.scheduleSandboxProbe();
    this.ensureInitialized();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (this.sandboxProbeTimer) {
      clearInterval(this.sandboxProbeTimer);
      this.sandboxProbeTimer = null;
    }
    this.sandbox.close();
    if (this.sandbox.isConfigured() || this.sandbox.isRequired()) {
      return;
    }
    for (const job of this.queue.splice(0)) {
      this.queueWaitMs.record(Math.max(0, performance.now() - job.enqueuedAt));
      this.finishJob(job, this.failedOpen(job, 'shutting_down'));
    }

    const exitWaiters: ChildExitWaiter[] = [];
    const children: ChildProcess[] = [];
    for (const slot of this.slots) {
      if (slot.restartTimer) {
        clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
      clearSlotTimer(slot, 'startupTimer');
      clearSlotTimer(slot, 'killTimer');
      if (slot.current) {
        this.finishJob(slot.current, this.failedOpen(slot.current, 'shutting_down'));
        slot.current = null;
      }
      const child = slot.process;
      if (!child) {
        continue;
      }
      children.push(child);
      exitWaiters.push(createChildExitWaiter(child));
      slot.retirementReason = 'shutdown';
      this.sendToWorker(child, { type: 'shutdown' });
      child.kill('SIGTERM');
    }

    const allExited = Promise.allSettled(exitWaiters.map(({ promise }) => promise));
    await waitBounded(allExited, WORKER_SHUTDOWN_GRACE_MS);
    for (const slot of this.slots) {
      if (slot.process && slot.process.exitCode === null && slot.process.signalCode === null) {
        slot.process.kill('SIGKILL');
      }
    }
    await waitBounded(allExited, WORKER_FORCE_EXIT_GRACE_MS);
    for (const waiter of exitWaiters) {
      waiter.cancel();
    }
    for (const child of children) {
      detachWorkerListeners(child);
    }
    for (const slot of this.slots) {
      slot.process = null;
      slot.ready = false;
    }
  }

  getRuntimeStatus(): NativeTesseractRuntimeStatus {
    if (this.sandbox.isConfigured() || this.sandbox.isRequired()) {
      return this.getSandboxRuntimeStatus();
    }
    const live = this.slots.filter((slot) => isChildLive(slot.process)).length;
    const readyWorkers = this.slots.filter(
      (slot) => isChildLive(slot.process) && slot.ready && slot.retirementReason === null,
    ).length;
    const busy = this.slots.filter((slot) => slot.current !== null).length;
    const artifactReady = this.nativeArtifactsReadyForRecognition();
    const ready = this.initialized && !this.shuttingDown && readyWorkers > 0 && artifactReady;
    const state = this.shuttingDown
      ? 'shutting_down'
      : ready
        ? 'ready'
        : (this.nativeArtifactVerificationRequired &&
              this.nativeArtifactVerification !== null &&
              !this.nativeArtifactVerification.verified) ||
            (this.initialized && this.slots.some((slot) => slot.retryAfter > performance.now()))
          ? 'degraded'
          : 'starting';
    const total = this.completedCount + this.failedCount;
    return {
      state,
      ready,
      workers: { configured: this.concurrency, live, ready: readyWorkers, busy },
      queueDepth: this.queue.length,
      queueWaitMs: this.queueWaitMs.snapshot(),
      counters: {
        completed: this.completedCount,
        failed: this.failedCount,
        restarts: this.restartCount,
        recycles: this.recycleCount,
        failuresByReason: Object.fromEntries(this.failuresByReason),
      },
      latencyMs: {
        last: this.lastLatencyMs,
        average: total > 0 ? roundDuration(this.totalLatencyMs / total) : null,
        maximum: this.maxLatencyMs,
      },
      behaviorIdentity: this.getNativeBehaviorIdentityStatus(),
      boundary: {
        kind: 'local_worker',
        required: false,
        verified: false,
      },
    };
  }

  isSandboxBoundaryVerified(): boolean {
    return (
      this.sandbox.isConfigured() &&
      this.sandbox.isVerified() &&
      this.nativeArtifactsReadyForRecognition()
    );
  }

  private startNativeArtifactVerification(): void {
    if (
      !this.nativeArtifactVerificationRequired ||
      this.nativeArtifactVerificationPromise ||
      this.nativeArtifactVerification !== null
    ) {
      return;
    }
    const verification = this.verifyNativeBehaviorIdentity()
      .then((result) => {
        this.nativeArtifactVerificationFailureReason = 'artifact_unverified';
        const identityMismatch =
          result.verified &&
          result.identity.fingerprintSha256 !== this.nativeBehaviorIdentity.fingerprintSha256;
        const identityIncomplete =
          result.verified && (!result.identity.complete || !this.nativeBehaviorIdentity.complete);
        this.nativeArtifactVerification =
          identityMismatch || identityIncomplete
            ? {
                ...result,
                verified: false,
                status: 'mismatch',
                mismatches: [
                  ...result.mismatches,
                  ...(identityMismatch ? ['controls.productionProfile'] : []),
                  ...(identityIncomplete ? ['identity.incomplete'] : []),
                ],
              }
            : result;
        if (this.nativeArtifactsReadyForRecognition()) {
          this.ensureInitialized();
          this.dispatch();
        }
      })
      .catch((error: unknown) => {
        this.recordNativeArtifactVerificationFailure(error, 'artifacts.unavailable');
      })
      .finally(() => {
        if (this.nativeArtifactVerificationPromise === verification) {
          this.nativeArtifactVerificationPromise = null;
        }
      });
    this.nativeArtifactVerificationPromise = verification;
  }

  protected verifyNativeBehaviorIdentity(): Promise<CommercialOcrNativeArtifactVerification> {
    if (this.sandbox.isConfigured()) {
      return this.sandbox.probe();
    }
    if (this.sandbox.isRequired()) {
      return Promise.resolve({
        verified: false,
        status: 'probe_failed',
        mismatches: Object.freeze(['boundary.unconfigured']),
        identity: this.nativeBehaviorIdentity,
      });
    }
    return resolveVerifiedCommercialOcrNativeBehaviorIdentity(this.configService);
  }

  private scheduleSandboxProbe(): void {
    if (!this.sandbox.isConfigured() || !this.sandbox.isRequired() || this.sandboxProbeTimer) {
      return;
    }
    this.sandboxProbeTimer = setInterval(() => {
      void this.refreshSandboxVerification();
    }, SANDBOX_PROBE_INTERVAL_MS);
    this.sandboxProbeTimer.unref();
  }

  private async refreshSandboxVerification(): Promise<void> {
    if (this.shuttingDown) return;
    try {
      const result = await this.sandbox.probe();
      this.nativeArtifactVerificationFailureReason = 'artifact_unverified';
      const valid =
        result.verified &&
        result.identity.complete &&
        this.nativeBehaviorIdentity.complete &&
        result.identity.fingerprintSha256 === this.nativeBehaviorIdentity.fingerprintSha256;
      this.nativeArtifactVerification = valid
        ? result
        : {
            ...result,
            verified: false,
            status: 'mismatch',
            mismatches: Object.freeze([...result.mismatches, 'boundary.identity']),
          };
      if (valid) {
        this.ensureInitialized();
      }
    } catch (error: unknown) {
      this.recordNativeArtifactVerificationFailure(error, 'boundary.probe_failed');
    }
  }

  private recordNativeArtifactVerificationFailure(
    error: unknown,
    fallbackMismatch: 'artifacts.unavailable' | 'boundary.probe_failed',
  ): void {
    const boundaryReason =
      this.sandbox.isConfigured() && error instanceof NativeOcrSandboxUnavailableError
        ? error.reason
        : null;
    // FLAG: Only an isolated sandbox transport outage may use bounded job retries.
    // Artifact or boundary mismatches remain terminal until a fresh exact probe succeeds.
    this.nativeArtifactVerificationFailureReason =
      this.sandbox.isRequired() &&
      this.nativeBehaviorIdentity.complete &&
      boundaryReason === 'unavailable'
        ? 'worker_unavailable'
        : 'artifact_unverified';
    this.nativeArtifactVerification = {
      verified: false,
      status:
        boundaryReason === 'unverified' || boundaryReason === 'invalid_response'
          ? 'mismatch'
          : 'probe_failed',
      mismatches: Object.freeze([
        boundaryReason === null ? fallbackMismatch : `boundary.${boundaryReason}`,
      ]),
      identity: this.nativeBehaviorIdentity,
    };
  }

  private nativeArtifactsReadyForRecognition(): boolean {
    return (
      !this.nativeArtifactVerificationRequired ||
      (this.nativeBehaviorIdentity.complete &&
        this.nativeArtifactVerification?.verified === true &&
        this.nativeArtifactVerification.identity.complete)
    );
  }

  private getNativeBehaviorIdentityStatus(): NativeTesseractBehaviorIdentityStatus {
    const verification = this.nativeArtifactVerification;
    const state = !this.nativeArtifactVerificationRequired
      ? 'not_required'
      : verification === null
        ? 'pending'
        : verification.verified
          ? 'verified'
          : 'failed';
    return Object.freeze({
      fingerprintSha256: this.nativeBehaviorIdentity.fingerprintSha256,
      runtimeFingerprintSha256: verification?.identity.fingerprintSha256 ?? null,
      buildManifestSha256: this.nativeBehaviorIdentity.manifest.buildManifestSha256,
      complete: this.nativeBehaviorIdentity.complete,
      required: this.nativeArtifactVerificationRequired,
      verified: verification?.verified === true,
      state,
      mismatchFields: Object.freeze([...(verification?.mismatches ?? [])]),
    });
  }

  recognize(
    image: Buffer,
    options: NativeTesseractRecognizeOptions = {},
  ): Promise<NativeTesseractOcrResult> {
    const startedAt = performance.now();
    const psm = options.psm ?? DEFAULT_PSM;
    const passLabel = normalizePassLabel(options.passLabel);
    if (
      !Buffer.isBuffer(image) ||
      image.byteLength === 0 ||
      image.byteLength > this.maxImageBytes ||
      !isAllowedPsm(psm) ||
      passLabel === null
    ) {
      return this.failImmediately(
        startedAt,
        passLabel ?? 'invalid',
        isAllowedPsm(psm) ? psm : DEFAULT_PSM,
        'invalid_input',
      );
    }
    if (this.shuttingDown) {
      return this.failImmediately(startedAt, passLabel, psm, 'shutting_down');
    }
    if (!this.nativeArtifactsReadyForRecognition()) {
      this.startNativeArtifactVerification();
      return this.failImmediately(
        startedAt,
        passLabel,
        psm,
        this.nativeArtifactVerificationFailureReason,
      );
    }

    if (this.sandbox.isConfigured()) {
      return this.recognizeInSandbox(image, psm, passLabel, startedAt, options.deadlineAtMs);
    }
    // FLAG: Production media analysis must never fall back to an in-container native worker.
    if (this.sandbox.isRequired()) {
      return this.failImmediately(startedAt, passLabel, psm, 'worker_unavailable');
    }

    const externalRemainingMs =
      options.deadlineAtMs === undefined
        ? null
        : Number.isSafeInteger(options.deadlineAtMs)
          ? options.deadlineAtMs - Date.now()
          : 0;
    if (externalRemainingMs !== null && externalRemainingMs <= WORKER_RESULT_GRACE_MS) {
      return this.failImmediately(startedAt, passLabel, psm, 'timeout');
    }

    this.ensureInitialized();
    this.retryUnavailableWorkers();
    const hasLiveWorker = this.slots.some((slot) => isChildLive(slot.process));
    if (!hasLiveWorker) {
      return this.failImmediately(startedAt, passLabel, psm, 'worker_unavailable');
    }
    if (
      !this.slots.some((slot) => slot.ready && !slot.current) &&
      this.queue.length >= this.maxQueue
    ) {
      return this.failImmediately(startedAt, passLabel, psm, 'capacity_exhausted');
    }

    return new Promise<NativeTesseractOcrResult>((resolvePromise) => {
      const timeoutMs =
        externalRemainingMs === null
          ? this.timeoutMs
          : Math.min(this.timeoutMs, externalRemainingMs - WORKER_RESULT_GRACE_MS);
      const deadlineAt = performance.now() + timeoutMs;
      const watchdogMs = timeoutMs + WORKER_RESULT_GRACE_MS;
      const job: OcrJob = {
        id: randomUUID(),
        image: Buffer.from(image),
        psm,
        passLabel,
        startedAt,
        enqueuedAt: performance.now(),
        deadlineAt,
        settled: false,
        resolve: resolvePromise,
        timer: setTimeout(() => this.handleJobTimeout(job), watchdogMs),
      };
      job.timer.unref();
      this.queue.push(job);
      this.dispatch();
    });
  }

  private ensureInitialized(): void {
    if (this.initialized || this.shuttingDown || !this.nativeArtifactsReadyForRecognition()) {
      return;
    }
    this.initialized = true;
    if (this.sandbox.isConfigured() || this.sandbox.isRequired()) {
      return;
    }
    for (let id = 0; id < this.concurrency; id += 1) {
      const slot: WorkerSlot = {
        id,
        generation: 0,
        process: null,
        ready: false,
        retirementReason: null,
        restartAttempts: 0,
        retryAfter: 0,
        jobsProcessed: 0,
        current: null,
        restartTimer: null,
        startupTimer: null,
        killTimer: null,
      };
      this.slots.push(slot);
      this.startWorker(slot);
    }
  }

  private startWorker(slot: WorkerSlot): void {
    if (this.shuttingDown || slot.process) {
      return;
    }
    slot.generation += 1;
    if (slot.generation > 1) {
      this.restartCount += 1;
    }
    const generation = slot.generation;
    slot.ready = false;
    slot.retirementReason = null;
    slot.jobsProcessed = 0;

    let child: ChildProcess;
    try {
      child = this.forkWorker(this.workerPath, {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        env: workerEnvironment(
          this.binary,
          this.tessdataPrefix,
          this.maxOutputBytes,
          this.maxImageBytes,
          this.timeoutMs,
          this.ompThreadLimit,
        ),
      });
    } catch {
      slot.restartAttempts += 1;
      if (slot.restartAttempts > MAX_WORKER_RESTART_ATTEMPTS) {
        slot.retryAfter = performance.now() + WORKER_RETRY_COOLDOWN_MS;
        this.failQueuedIfNoWorkers();
      } else {
        this.scheduleWorkerRestart(slot, WORKER_RESTART_DELAY_MS);
      }
      return;
    }
    slot.process = child;
    slot.startupTimer = setTimeout(() => {
      if (slot.process === child && !slot.ready) {
        this.failAndRestartWorker(slot, 'worker_unavailable');
      }
    }, WORKER_STARTUP_TIMEOUT_MS);
    slot.startupTimer.unref();
    child.on('message', (message: unknown) => this.handleWorkerMessage(slot, generation, message));
    child.once('error', () => this.handleWorkerExit(slot, generation, child));
    child.once('exit', () => this.handleWorkerExit(slot, generation, child));
  }

  private handleWorkerMessage(slot: WorkerSlot, generation: number, message: unknown): void {
    if (generation !== slot.generation || !slot.process || !isWorkerResponse(message)) {
      if (generation === slot.generation && slot.process) {
        this.failAndRestartWorker(slot, 'invalid_output');
      }
      return;
    }
    if (message.type === 'ready') {
      clearSlotTimer(slot, 'startupTimer');
      slot.ready = true;
      this.dispatch();
      return;
    }

    const job = slot.current;
    if (!job || message.jobId !== job.id) {
      this.failAndRestartWorker(slot, 'invalid_output');
      return;
    }
    slot.current = null;
    slot.jobsProcessed += 1;
    if (message.retireWorker) {
      this.retireWorker(slot, 'failure');
    }
    if (message.result.ok) {
      const payload = message.result.payload;
      if (!isWorkerPayload(payload)) {
        this.finishJob(job, this.failedOpen(job, 'invalid_output'));
        this.retireWorker(slot, 'failure');
        this.dispatch();
        return;
      }
      this.finishJob(job, {
        ok: true,
        status: payload.text.length > 0 ? 'recognized' : 'no_text',
        passLabel: job.passLabel,
        psm: job.psm,
        ...payload,
        durationMs: elapsedMs(job.startedAt),
      });
    } else {
      this.finishJob(job, this.failedOpen(job, message.result.reason));
    }

    if (!message.retireWorker) {
      slot.restartAttempts = 0;
    }
    if (!message.retireWorker && slot.jobsProcessed >= this.recycleAfterJobs) {
      this.recycleCount += 1;
      this.retireWorker(slot, 'healthy_recycle');
    }
    this.dispatch();
  }

  private dispatch(): void {
    if (this.shuttingDown || !this.nativeArtifactsReadyForRecognition()) {
      return;
    }
    for (const slot of this.slots) {
      if (
        !isChildLive(slot.process) ||
        !slot.ready ||
        slot.current ||
        slot.retirementReason !== null
      ) {
        continue;
      }
      let job = this.queue.shift();
      while (job?.settled) {
        job = this.queue.shift();
      }
      if (!job) {
        return;
      }
      this.queueWaitMs.record(Math.max(0, performance.now() - job.enqueuedAt));
      const remainingMs = Math.floor(job.deadlineAt - performance.now());
      if (remainingMs <= 0) {
        this.finishJob(job, this.failedOpen(job, 'capacity_exhausted'));
        continue;
      }
      slot.current = job;
      this.sendToWorker(
        slot.process,
        {
          type: 'recognize',
          jobId: job.id,
          image: job.image,
          psm: job.psm,
          timeoutMs: remainingMs,
        },
        (error) => {
          if (error && slot.current === job) {
            this.failAndRestartWorker(slot, 'worker_unavailable');
          }
        },
      );
    }
  }

  private handleJobTimeout(job: OcrJob): void {
    if (job.settled) {
      return;
    }
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.queueWaitMs.record(Math.max(0, performance.now() - job.enqueuedAt));
      this.finishJob(job, this.failedOpen(job, 'capacity_exhausted'));
      return;
    }
    const slot = this.slots.find((candidate) => candidate.current === job);
    if (slot) {
      this.finishJob(job, this.failedOpen(job, 'worker_unavailable'));
      slot.current = null;
      this.retireWorker(slot, 'failure');
      this.dispatch();
    }
  }

  private failAndRestartWorker(slot: WorkerSlot, reason: NativeTesseractFailureReason): void {
    if (slot.current) {
      this.finishJob(slot.current, this.failedOpen(slot.current, reason));
      slot.current = null;
    }
    this.retireWorker(slot, 'failure');
    this.dispatch();
  }

  private retireWorker(
    slot: WorkerSlot,
    reason: Exclude<WorkerRetirementReason, 'shutdown'>,
  ): void {
    const child = slot.process;
    if (!child) {
      return;
    }
    if (slot.retirementReason !== null) {
      if (reason === 'failure' && slot.retirementReason === 'healthy_recycle') {
        slot.retirementReason = 'failure';
      }
      return;
    }
    slot.retirementReason = reason;
    slot.ready = false;
    clearSlotTimer(slot, 'startupTimer');
    this.sendToWorker(child, { type: 'shutdown' });
    child.kill('SIGTERM');
    slot.killTimer = setTimeout(
      () => {
        if (slot.process === child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      },
      reason === 'failure' ? WORKER_FORCE_EXIT_GRACE_MS : WORKER_SHUTDOWN_GRACE_MS,
    );
    slot.killTimer.unref();
  }

  private handleWorkerExit(slot: WorkerSlot, generation: number, child: ChildProcess): void {
    if (generation !== slot.generation || slot.process !== child) {
      return;
    }
    const retirementReason = slot.retirementReason ?? 'failure';
    slot.process = null;
    clearSlotTimer(slot, 'startupTimer');
    clearSlotTimer(slot, 'killTimer');
    slot.ready = false;
    slot.retirementReason = null;
    if (slot.current) {
      this.finishJob(slot.current, this.failedOpen(slot.current, 'worker_unavailable'));
      slot.current = null;
    }
    if (this.shuttingDown) {
      return;
    }

    if (retirementReason === 'failure') {
      slot.restartAttempts += 1;
    }
    if (retirementReason === 'failure' && slot.restartAttempts > MAX_WORKER_RESTART_ATTEMPTS) {
      slot.retryAfter = performance.now() + WORKER_RETRY_COOLDOWN_MS;
      this.failQueuedIfNoWorkers();
      return;
    }
    this.scheduleWorkerRestart(slot, retirementReason === 'failure' ? WORKER_RESTART_DELAY_MS : 0);
  }

  private scheduleWorkerRestart(slot: WorkerSlot, delayMs: number): void {
    if (slot.restartTimer || this.shuttingDown) {
      return;
    }
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null;
      this.startWorker(slot);
    }, delayMs);
    slot.restartTimer.unref();
  }

  private retryUnavailableWorkers(): void {
    const now = performance.now();
    for (const slot of this.slots) {
      if (!slot.process && !slot.restartTimer && slot.retryAfter <= now) {
        slot.restartAttempts = 0;
        slot.retryAfter = 0;
        this.startWorker(slot);
      }
    }
  }

  private failQueuedIfNoWorkers(): void {
    if (this.slots.some((slot) => isChildLive(slot.process) || slot.restartTimer)) {
      return;
    }
    for (const job of this.queue.splice(0)) {
      this.queueWaitMs.record(Math.max(0, performance.now() - job.enqueuedAt));
      this.finishJob(job, this.failedOpen(job, 'worker_unavailable'));
    }
  }

  private finishJob(job: OcrJob, result: NativeTesseractOcrResult): void {
    if (job.settled) {
      return;
    }
    job.settled = true;
    clearTimeout(job.timer);
    job.image = Buffer.alloc(0);
    this.recordResult(result);
    job.resolve(result);
  }

  private failImmediately(
    startedAt: number,
    passLabel: string,
    psm: NativeTesseractPageSegmentationMode,
    reason: NativeTesseractFailureReason,
  ): Promise<NativeTesseractFailedOpenResult> {
    const result = this.buildFailedOpenResult(startedAt, passLabel, psm, reason);
    this.recordResult(result);
    return Promise.resolve(result);
  }

  private recordResult(result: NativeTesseractOcrResult): void {
    const durationMs = result.durationMs;
    this.lastLatencyMs = durationMs;
    this.totalLatencyMs += durationMs;
    this.maxLatencyMs = Math.max(this.maxLatencyMs ?? 0, durationMs);
    if (result.ok) {
      this.completedCount += 1;
    } else {
      this.failedCount += 1;
      this.failuresByReason.set(result.reason, (this.failuresByReason.get(result.reason) ?? 0) + 1);
    }
  }

  private failedOpen(
    job: OcrJob,
    reason: NativeTesseractFailureReason,
  ): NativeTesseractFailedOpenResult {
    return this.buildFailedOpenResult(job.startedAt, job.passLabel, job.psm, reason);
  }

  private buildFailedOpenResult(
    startedAt: number,
    passLabel: string,
    psm: NativeTesseractPageSegmentationMode,
    reason: NativeTesseractFailureReason,
  ): NativeTesseractFailedOpenResult {
    this.logger.debug(`Native Tesseract pass failed open: ${reason}`);
    return {
      ok: false,
      status: 'failed_open',
      passLabel,
      psm,
      reason,
      durationMs: elapsedMs(startedAt),
    };
  }

  private sendToWorker(
    child: ChildProcess,
    request: NativeTesseractWorkerRequest,
    callback?: (error: Error | null) => void,
  ): void {
    if (!child.connected) {
      callback?.(new Error('Tesseract worker IPC is disconnected'));
      return;
    }
    try {
      child.send(request, callback);
    } catch (error: unknown) {
      callback?.(error instanceof Error ? error : new Error('Tesseract worker IPC failed'));
    }
  }

  protected forkWorker(path: string, options: Parameters<typeof fork>[2]): ChildProcess {
    return fork(path, [], options);
  }

  private async recognizeInSandbox(
    image: Buffer,
    psm: NativeTesseractPageSegmentationMode,
    passLabel: string,
    startedAt: number,
    deadlineAtMs: number | undefined,
  ): Promise<NativeTesseractOcrResult> {
    const remainingMs =
      deadlineAtMs === undefined
        ? this.timeoutMs
        : Number.isSafeInteger(deadlineAtMs)
          ? Math.min(
              this.timeoutMs,
              Math.max(0, deadlineAtMs - Date.now() - NATIVE_OCR_SANDBOX_IPC_GRACE_MS),
            )
          : 0;
    if (remainingMs < 1) {
      return this.failImmediately(startedAt, passLabel, psm, 'request_deadline_exceeded');
    }
    try {
      const result = await this.sandbox.recognize(image, psm, remainingMs, { deadlineAtMs });
      if (!result.ok) {
        const failed = this.buildFailedOpenResult(startedAt, passLabel, psm, result.reason);
        this.recordResult(failed);
        return failed;
      }
      const recognized: NativeTesseractOcrResult = {
        ok: true,
        status: result.payload.text.length > 0 ? 'recognized' : 'no_text',
        passLabel,
        psm,
        ...result.payload,
        durationMs: elapsedMs(startedAt),
      };
      this.recordResult(recognized);
      return recognized;
    } catch (error: unknown) {
      if (
        error instanceof NativeOcrSandboxRequestError ||
        error instanceof NativeOcrSandboxRequestTimeoutError
      ) {
        const failed = this.buildFailedOpenResult(
          startedAt,
          passLabel,
          psm,
          error instanceof NativeOcrSandboxRequestTimeoutError ? 'request_timeout' : error.reason,
        );
        this.recordResult(failed);
        return failed;
      }
      let reason: NativeTesseractFailureReason;
      if (this.sandbox.count > 1 && this.sandbox.isVerified()) {
        // FLAG: Preserve independently attested peers. The failing lane was quarantined by
        // the pool and will only serve work again after a new verified probe.
        reason =
          error instanceof NativeOcrSandboxUnavailableError && error.reason === 'unavailable'
            ? 'worker_unavailable'
            : 'artifact_unverified';
      } else {
        this.recordNativeArtifactVerificationFailure(error, 'boundary.probe_failed');
        reason = this.nativeArtifactVerificationFailureReason;
      }
      const failed = this.buildFailedOpenResult(
        startedAt,
        passLabel,
        psm,
        this.shuttingDown ? 'shutting_down' : reason,
      );
      this.recordResult(failed);
      return failed;
    }
  }

  private getSandboxRuntimeStatus(): NativeTesseractRuntimeStatus {
    const boundary = this.sandbox.getStatus();
    const statuses = this.sandbox.count > 1 ? this.sandbox.getStatuses() : [boundary];
    const lanes = statuses.map((status) => {
      const observedAtMs = status.runtimeStatusObservedAtMs;
      const ageMs = observedAtMs === null ? Infinity : Date.now() - observedAtMs;
      const snapshot =
        status.verified && ageMs >= 0 && ageMs <= 2 * SANDBOX_PROBE_INTERVAL_MS
          ? status.runtimeStatus
          : null;
      return { verified: status.verified, observedAtMs, snapshot };
    });
    const verifiedLanes = lanes.filter((lane) => lane.verified).length;
    const runtime = lanes[0]!.snapshot;
    const pool = this.sandbox.count > 1;
    const allDiagnosed = lanes.every((lane) => lane.snapshot !== null);
    const artifactReady = this.nativeArtifactsReadyForRecognition();
    const ready =
      this.initialized &&
      !this.shuttingDown &&
      boundary.configured &&
      verifiedLanes > 0 &&
      artifactReady;
    const total = this.completedCount + this.failedCount;
    return {
      state: this.shuttingDown
        ? 'shutting_down'
        : ready
          ? 'ready'
          : this.nativeArtifactVerification !== null && !this.nativeArtifactVerification.verified
            ? 'degraded'
            : 'starting',
      ready,
      workers: {
        configured: this.sandbox.isConfigured() ? this.sandbox.count : this.concurrency,
        live: verifiedLanes,
        ready: ready ? verifiedLanes : 0,
        busy: allDiagnosed
          ? lanes.filter((lane) => lane.snapshot!.activeOperation !== 'idle').length
          : null,
      },
      queueDepth: allDiagnosed
        ? lanes.reduce((sum, lane) => sum + lane.snapshot!.queueDepth, 0)
        : null,
      sandboxRuntime: {
        available: pool ? allDiagnosed : runtime !== null,
        observedAtMs: pool
          ? allDiagnosed
            ? Math.min(...lanes.map((lane) => lane.observedAtMs!))
            : null
          : boundary.runtimeStatusObservedAtMs,
        snapshot: pool ? null : runtime,
        ...(pool ? { lanes } : {}),
      },
      queueWaitMs: allDiagnosed
        ? summarizeSandboxQueueWait(lanes.map(({ snapshot }) => snapshot!))
        : {
            observed: null,
            sampled: null,
            capacity: QUEUE_WAIT_SAMPLE_CAPACITY * lanes.length,
            last: null,
            average: null,
            maximum: null,
            p95: null,
            p99: null,
          },
      counters: {
        completed: this.completedCount,
        failed: this.failedCount,
        restarts: this.restartCount + statuses.reduce((sum, status) => sum + status.restarts, 0),
        recycles: this.recycleCount,
        failuresByReason: Object.fromEntries(this.failuresByReason),
      },
      latencyMs: {
        last: this.lastLatencyMs,
        average: total > 0 ? roundDuration(this.totalLatencyMs / total) : null,
        maximum: this.maxLatencyMs,
      },
      behaviorIdentity: this.getNativeBehaviorIdentityStatus(),
      boundary: {
        kind: boundary.kind,
        required: boundary.required,
        verified: ready,
      },
    };
  }
}

function summarizeSandboxQueueWait(
  runtimes: readonly NativeOcrSandboxRuntimeStatus[],
): NativeTesseractQueueWaitSnapshot {
  let observed = 0;
  let sampled = 0;
  let total = 0;
  let maximum: number | null = null;
  for (const runtime of runtimes) {
    const { counters, queueWaitMs } = runtime;
    // Include valid pre-start refusals as well as native starts, without counting local defers.
    observed +=
      counters.started +
      counters.rejections.capacity_exhausted +
      counters.rejections.request_deadline_exceeded +
      counters.rejections.shutting_down;
    sampled += queueWaitMs.samples;
    total += (queueWaitMs.average ?? 0) * queueWaitMs.samples;
    if (queueWaitMs.maximum !== null) {
      maximum = Math.max(maximum ?? 0, queueWaitMs.maximum);
    }
  }
  return {
    observed: Math.min(Number.MAX_SAFE_INTEGER, observed),
    sampled,
    capacity: QUEUE_WAIT_SAMPLE_CAPACITY * runtimes.length,
    // Each lane exposes only its last value, without its sample timestamp.
    last: runtimes.length === 1 ? runtimes[0]!.queueWaitMs.last : null,
    average: sampled > 0 ? roundDuration(total / sampled) : null,
    maximum,
    p95: null,
    p99: null,
  };
}

function isAllowedPsm(value: unknown): value is NativeTesseractPageSegmentationMode {
  return (NATIVE_TESSERACT_PAGE_SEGMENTATION_MODES as readonly unknown[]).includes(value);
}

function normalizePassLabel(value: string | undefined): string | null {
  const normalized = (value ?? 'primary').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(normalized) ? normalized : null;
}

function elapsedMs(startedAt: number): number {
  return roundDuration(performance.now() - startedAt);
}

function roundDuration(durationMs: number): number {
  return Math.max(0, Math.round(durationMs * 100) / 100);
}

function nearestRank(sortedValues: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index]!;
}

function workerEnvironment(
  binary: string,
  tessdataPrefix: string | undefined,
  maxOutputBytes: number,
  maxImageBytes: number,
  timeoutMs: number,
  ompThreadLimit: number,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    NODE_ENV: process.env.NODE_ENV,
    OMP_THREAD_LIMIT: String(ompThreadLimit),
    COMMERCIAL_OCR_TESSERACT_BINARY: binary,
    COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: String(maxOutputBytes),
    COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: String(maxImageBytes),
    COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: String(timeoutMs),
    ...(tessdataPrefix ? { COMMERCIAL_OCR_TESSDATA_PREFIX: tessdataPrefix } : {}),
  };
}

function isWorkerResponse(value: unknown): value is NativeTesseractWorkerResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<NativeTesseractWorkerResponse>;
  if (candidate.type === 'ready') {
    return true;
  }
  if (candidate.type !== 'result') {
    return false;
  }
  const resultMessage = candidate as Partial<NativeTesseractWorkerResultResponse>;
  if (
    typeof resultMessage.jobId !== 'string' ||
    typeof resultMessage.retireWorker !== 'boolean' ||
    !resultMessage.result ||
    typeof resultMessage.result !== 'object'
  ) {
    return false;
  }
  if (resultMessage.result.ok === true) {
    return 'payload' in resultMessage.result;
  }
  return (
    resultMessage.result.ok === false &&
    isWorkerFailureReason((resultMessage.result as { reason?: unknown }).reason)
  );
}

function isWorkerFailureReason(value: unknown): boolean {
  return (
    value === 'timeout' ||
    value === 'tesseract_failed' ||
    value === 'output_limit' ||
    value === 'invalid_output'
  );
}

function isWorkerPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.length <= 8_000 &&
    (candidate.aggregateConfidence === null || isConfidence(candidate.aggregateConfidence)) &&
    Array.isArray(candidate.words) &&
    Array.isArray(candidate.lines) &&
    typeof candidate.truncated === 'boolean' &&
    candidate.words.every(isWordSpan) &&
    candidate.lines.every(isLineSpan)
  );
}

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isWordSpan(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.length > 0 &&
    isNonNegativeInteger(candidate.start) &&
    isNonNegativeInteger(candidate.end) &&
    candidate.end >= candidate.start &&
    isConfidence(candidate.confidence) &&
    isNonNegativeInteger(candidate.lineIndex) &&
    isBoundingBox(candidate.boundingBox)
  );
}

function isLineSpan(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === 'string' &&
    candidate.text.length > 0 &&
    isNonNegativeInteger(candidate.start) &&
    isNonNegativeInteger(candidate.end) &&
    candidate.end >= candidate.start &&
    isConfidence(candidate.confidence) &&
    isNonNegativeInteger(candidate.wordStartIndex) &&
    isNonNegativeInteger(candidate.wordEndIndex) &&
    candidate.wordEndIndex >= candidate.wordStartIndex &&
    isBoundingBox(candidate.boundingBox)
  );
}

function isBoundingBox(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isNonNegativeInteger(candidate.left) &&
    isNonNegativeInteger(candidate.top) &&
    isNonNegativeInteger(candidate.width) &&
    isNonNegativeInteger(candidate.height) &&
    candidate.width > 0 &&
    candidate.height > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function resolveWorkerPath(directory: string): string {
  const compiled = resolve(directory, 'native-tesseract-worker.js');
  return existsSync(compiled) ? compiled : resolve(directory, 'native-tesseract-worker.ts');
}

function clearSlotTimer(slot: WorkerSlot, field: 'startupTimer' | 'killTimer'): void {
  const timer = slot[field];
  if (timer) {
    clearTimeout(timer);
    slot[field] = null;
  }
}

type ChildExitWaiter = {
  promise: Promise<void>;
  cancel: () => void;
};

function createChildExitWaiter(child: ChildProcess): ChildExitWaiter {
  if (!isChildLive(child)) {
    return { promise: Promise.resolve(), cancel: () => undefined };
  }

  let active = true;
  let resolveExit!: () => void;
  const onExit = () => {
    if (!active) return;
    active = false;
    child.removeListener('exit', onExit);
    resolveExit();
  };
  const promise = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise;
    child.once('exit', onExit);
  });
  return {
    promise,
    cancel: () => {
      if (!active) return;
      active = false;
      child.removeListener('exit', onExit);
      resolveExit();
    },
  };
}

function isChildLive(child: ChildProcess | null): child is ChildProcess {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

function detachWorkerListeners(child: ChildProcess): void {
  child.removeAllListeners('message');
  child.removeAllListeners('error');
  child.removeAllListeners('exit');
  if (!isChildLive(child)) {
    return;
  }

  const onLateError = () => undefined;
  const onLateExit = () => {
    child.removeListener('error', onLateError);
    child.removeListener('exit', onLateExit);
  };
  child.on('error', onLateError);
  child.once('exit', onLateExit);
}

function waitBounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise();
    };
    const timeout = setTimeout(finish, timeoutMs);
    timeout.unref();
    operation.then(finish, finish);
  });
}
