import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Redis from 'ioredis';

import {
  fingerprintCommercialOcrNativeBehaviorManifest,
  isCommercialOcrNativeBehaviorManifestComplete,
  resolveCommercialOcrBehaviorDescriptor,
  resolveCommercialOcrBehaviorIdentity,
  resolveCommercialOcrProductionBehaviorDescriptor,
  type CommercialOcrBehaviorIdentity,
  type CommercialOcrNativeRuntimeControls,
} from './commercial-ocr-behavior-identity';
import { COMMERCIAL_OCR_DECISION_POLICY_VERSION } from './commercial-ocr-decision-policy';
import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from './commercial-ocr-detector-source.generated';
import type { CommercialOcrPreprocessLimits } from './commercial-ocr-preprocessor';
import { COMMERCIAL_OCR_REDIS_OPTIONS } from './commercial-ocr-redis.options';
import {
  COMMERCIAL_OCR_DEFAULT_VERSION,
  resolveCommercialOcrJobPurposes,
  type CommercialOcrJob,
} from './commercial-ocr.queue';
import type {
  CommercialOcrLogicalRecordingContext,
  CommercialOcrLogicalRecordingResult,
} from './commercial-ocr-admission.store';
import {
  COMMERCIAL_OCR_TERMINAL_OUTCOMES,
  COMMERCIAL_OCR_TERMINAL_REASONS,
  type CommercialOcrTerminalResult,
} from './commercial-ocr-terminal';

const ROLLING_SAMPLE_CAPACITY = 512;
const CGROUP_V2_CPU_STAT_PATH = '/sys/fs/cgroup/cpu.stat';
const CGROUP_V1_CPU_USAGE_PATH = '/sys/fs/cgroup/cpuacct/cpuacct.usage';
const METRICS_NAMESPACE = 'commercial-ocr:metrics:v2';
const METRICS_BUCKET_SPAN_SEC = 15 * 60;
const METRICS_WINDOW_SEC = 24 * 60 * 60;
const METRICS_BUCKET_RETENTION_SEC = 3 * 24 * 60 * 60;
const METRICS_RELEASE_RETENTION_SEC = 90 * 24 * 60 * 60;
const METRICS_BATCH_DEDUPE_RETENTION_SEC = METRICS_RELEASE_RETENTION_SEC;
const METRICS_FAILURE_LOG_INTERVAL_MS = 30_000;
const METRICS_FLUSH_INTERVAL_MS = 1_000;
const METRICS_AGGREGATE_CACHE_MS = 10_000;

const RECORD_COUNTER_SCRIPT = `
local releaseKey = KEYS[1]
local bucketKey = KEYS[2]
local processDedupeKey = KEYS[3]
local startedAtMs = ARGV[1]
local releaseTtlSec = tonumber(ARGV[2]) or 7776000
local bucketTtlSec = tonumber(ARGV[3]) or 259200
local dedupeTtlSec = tonumber(ARGV[4]) or releaseTtlSec
local batchSequence = tonumber(ARGV[5])
if not batchSequence or batchSequence < 1 then
  return redis.error_reply('invalid commercial OCR metrics batch sequence')
end

local lastSequence = tonumber(redis.call('GET', processDedupeKey))
if lastSequence and batchSequence <= lastSequence then
  redis.call('EXPIRE', processDedupeKey, dedupeTtlSec)
  return 0
end
redis.call('SET', processDedupeKey, batchSequence, 'EX', dedupeTtlSec)

redis.call('HSETNX', releaseKey, 'started_at_ms', startedAtMs)
for index = 6, #ARGV, 2 do
  local field = ARGV[index]
  local amount = tonumber(ARGV[index + 1]) or 0
  if amount > 0 then
    redis.call('HINCRBY', releaseKey, 'counter:' .. field, amount)
    redis.call('HINCRBY', bucketKey, 'counter:' .. field, amount)
  end
end
redis.call('EXPIRE', releaseKey, releaseTtlSec)
redis.call('EXPIRE', bucketKey, bucketTtlSec)
return 1
`;

const SOURCE_READ_FAILURE_KINDS = [
  'access_denied',
  'access_or_missing',
  'remote_rate_limit',
  'circuit_open',
  'local_rate_limit',
  'timeout',
  'remote_server',
  'remote_client',
  'response_missing_id',
  'unknown',
] as const;

export type CommercialOcrSourceFailureKind = (typeof SOURCE_READ_FAILURE_KINDS)[number];

export const COMMERCIAL_OCR_METRIC_COUNTERS = [
  'enqueue.queued',
  'enqueue.skipped',
  'enqueue.failed',
  'admission.admitted.pending',
  'admission.admitted.actionable',
  'admission.admitted.observation',
  'admission.duplicate.pending',
  'admission.duplicate.actionable',
  'admission.duplicate.observation',
  'admission.rejected.global',
  'admission.rejected.actionable_reserve',
  'admission.rejected.chat',
  'admission.rejected.age',
  'admission.image_units.admitted',
  'admission.image_units.rejected_global',
  'admission.image_units.rejected_chat',
  'admission.image_units.rejected_actionable_reserve',
  'admission.unavailable',
  'admission.activation.activated',
  'admission.activation.already_actionable',
  'admission.activation.suppressed',
  'admission.activation.expired',
  'admission.activation.missing',
  'admission.activation.unavailable',
  'admission.reconciliation.attempted',
  'admission.reconciliation.activated',
  'admission.reconciliation.suppressed',
  'admission.reconciliation.unavailable',
  'admission.suppression.suppressed',
  'admission.suppression.unavailable',
  'bullmq.job.started',
  'bullmq.job.completed',
  'bullmq.job.expired',
  'bullmq.job.invalid',
  'bullmq.job.failed',
  'bullmq.job.retry.download_failed',
  'bullmq.job.retry.ocr_failed',
  'bullmq.job.retry.source_unavailable',
  'source.exact.retry',
  'logical.started',
  'logical.terminal',
  'logical.accounting.unavailable',
  'logical.accounting.missing',
  ...COMMERCIAL_OCR_TERMINAL_OUTCOMES.map((outcome) => `logical.outcome.${outcome}` as const),
  ...COMMERCIAL_OCR_TERMINAL_REASONS.map((reason) => `logical.reason.${reason}` as const),
  'bullmq.job.defer.source_not_ready',
  'bullmq.job.defer.governor_pressure',
  'bullmq.job.defer.admission_pending',
  'bullmq.job.defer.native_backpressure',
  'bullmq.job.deadline_exhausted.source_not_ready',
  'bullmq.job.deadline_exhausted.governor_pressure',
  'bullmq.job.deadline_exhausted.admission_pending',
  'bullmq.job.deadline_exhausted.native_backpressure',
  'source.ready',
  'source.receipt.unavailable',
  'source.receipt.missing',
  'source.receipt.owner_terminal',
  'source.receipt.no_replay_held',
  'source.receipt.failed',
  'source.receipt.invalid',
  'source.identity_mismatch',
  'source.creation_time_mismatch',
  'source.exact.unavailable',
  ...SOURCE_READ_FAILURE_KINDS.flatMap((kind) => [
    `source.exact.failure.initial.${kind}` as const,
    `source.exact.failure.revalidation.${kind}` as const,
  ]),
  'source.exact.absent',
  'source.exact.invalid',
  'source.exact.author_ineligible',
  'source.exact.changed',
  'album.image_count.1',
  'album.image_count.2_3',
  'album.image_count.4_6',
  'album.image_count.7_10',
  'analysis.complete.delete',
  'analysis.complete.no_action',
  'image_text_stop_list.complete.match',
  'image_text_stop_list.complete.no_action',
  'image_text_stop_list.enforcement.suppressed',
  'image_text_stop_list.enforcement.intent.requested',
  'analysis.incomplete.invalid_album',
  'analysis.incomplete.job_deadline_exceeded',
  'analysis.incomplete.missing_download_url',
  'analysis.incomplete.download_failed',
  'analysis.incomplete.image_rejected',
  'analysis.incomplete.preprocess_timeout',
  'analysis.incomplete.ocr_failed',
  'analysis.incomplete.ocr_timeout',
  'analysis.incomplete.ocr_request_timeout',
  'analysis.incomplete.ocr_truncated',
  'analysis.incomplete.invalid_ocr_output',
  'analysis.incomplete.pass.none',
  'analysis.incomplete.pass.primary',
  'analysis.incomplete.pass.confirmation',
  'analysis.retry.download_failed',
  'analysis.retry.ocr_failed',
  'analysis.defer.governor_pressure',
  'analysis.defer.native_backpressure',
  'analysis.terminal.complete',
  'analysis.terminal.incomplete',
  'cache.primary.hit',
  'cache.primary.miss',
  'cache.primary.coalesced',
  'cache.confirmation.hit',
  'cache.confirmation.miss',
  'cache.confirmation.coalesced',
  'confirmation.requested',
  'confirmation.completed',
  'stage.download.authorized',
  'stage.download.denied',
  'stage.ocr_dispatch.authorized',
  'stage.ocr_dispatch.denied',
  'stage.ocr.authorized',
  'stage.ocr.denied',
  'enforcement.suppressed.admission',
  'enforcement.suppressed.source_url_fallback',
  'enforcement.suppressed.script_guard',
  'enforcement.suppressed.deadline',
  'enforcement.suppressed.runtime_control',
  'enforcement.suppressed.runtime_control_expired',
  'enforcement.suppressed.authorization',
  'enforcement.suppressed.immunity',
  'enforcement.intent.requested',
] as const;

export type CommercialOcrMetricCounter = (typeof COMMERCIAL_OCR_METRIC_COUNTERS)[number];
export type CommercialOcrTerminalDeadlineExhaustedCounters = Readonly<{
  source_not_ready: number;
  governor_pressure: number;
  admission_pending: number;
  native_backpressure: number;
}>;
export type CommercialOcrStage =
  | 'source'
  | 'source_wait'
  | 'governor_wait'
  | 'native_wait'
  | 'download'
  | 'preprocess'
  | 'native'
  | 'policy'
  | 'end_to_end'
  | 'event_to_terminal';

type TimedSample = Readonly<{
  value: number;
  recordedAtMs: number;
}>;

type CounterValues = Readonly<Record<CommercialOcrMetricCounter, number>>;

type RemoteCounterBatch = Readonly<{
  sequence: number;
  bucketKey: string;
  entries: ReadonlyArray<readonly [CommercialOcrMetricCounter, number]>;
}>;

export type CommercialOcrRollingMetricSnapshot = Readonly<{
  observed: number;
  sampled: number;
  capacity: number;
  oldestSampleAt: string | null;
  newestSampleAt: string | null;
  last: number | null;
  average: number | null;
  p95: number | null;
  p99: number | null;
  maximum: number | null;
}>;

export type CommercialOcrCounterSnapshot = Readonly<{
  available: boolean;
  startedAt: string | null;
  generatedAt: string;
  counters: CounterValues;
}>;

export type CommercialOcrWindowCounterSnapshot = CommercialOcrCounterSnapshot &
  Readonly<{
    windowSec: number;
    bucketSpanSec: number;
    windowStartAt: string;
    windowEndAt: string;
  }>;

export type CommercialOcrRolloutMetricsSnapshot = Readonly<{
  behaviorRelease: Readonly<{
    scope: string;
    fingerprint: string;
    fingerprintSha256: string;
    nativeFingerprintSha256: string;
    nativeBuildManifestSha256: string | null;
    nativeIdentityComplete: boolean;
    nativeRuntimeControls: CommercialOcrNativeRuntimeControls;
    ocrVersion: typeof COMMERCIAL_OCR_DEFAULT_VERSION;
    decisionPolicyVersion: typeof COMMERCIAL_OCR_DECISION_POLICY_VERSION;
    detectorSourceSha256: typeof COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256;
    preprocessLimits: CommercialOcrPreprocessLimits;
  }>;
  logicalTerminalCoverage: Readonly<{
    started: number;
    terminal: number;
    inflightOrUnknown: number;
    accountingUnavailable: number;
    accountingMissing: number;
    complete: boolean;
  }>;
  processStartedAt: string;
  processCounters: CommercialOcrCounterSnapshot;
  releaseCounters: CommercialOcrCounterSnapshot;
  windowCounters: CommercialOcrWindowCounterSnapshot;
  bullMqQueueWaitMs: CommercialOcrRollingMetricSnapshot;
  /** Compatibility alias for bullMqQueueWaitMs. */
  queueWaitMs: CommercialOcrRollingMetricSnapshot;
  stageDurationMs: Readonly<Record<CommercialOcrStage, CommercialOcrRollingMetricSnapshot>>;
  nativePassDurationMs: CommercialOcrRollingMetricSnapshot;
  cpuSecondsPerImage: CommercialOcrRollingMetricSnapshot &
    Readonly<{
      unavailable: number;
      source: 'cgroup';
    }>;
}>;

export type CommercialOcrImageCpuSample = {
  startedUsageMicros: bigint | null;
  nativePasses: number;
  finished: boolean;
};

class BoundedRollingMetric {
  private readonly samples: Array<TimedSample | undefined>;
  private nextIndex = 0;
  private sampleCount = 0;
  private observedCount = 0;

  constructor(private readonly capacity: number) {
    this.samples = new Array<TimedSample | undefined>(capacity);
  }

  record(value: number, recordedAtMs = Date.now()): void {
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(recordedAtMs)) {
      return;
    }
    this.samples[this.nextIndex] = { value, recordedAtMs };
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.sampleCount = Math.min(this.capacity, this.sampleCount + 1);
    this.observedCount += 1;
  }

  snapshot(): CommercialOcrRollingMetricSnapshot {
    const samples = this.orderedSamples();
    if (samples.length === 0) {
      return {
        observed: this.observedCount,
        sampled: 0,
        capacity: this.capacity,
        oldestSampleAt: null,
        newestSampleAt: null,
        last: null,
        average: null,
        p95: null,
        p99: null,
        maximum: null,
      };
    }

    const values = samples.map((sample) => sample.value).sort((left, right) => left - right);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      observed: this.observedCount,
      sampled: samples.length,
      capacity: this.capacity,
      oldestSampleAt: new Date(samples[0]!.recordedAtMs).toISOString(),
      newestSampleAt: new Date(samples[samples.length - 1]!.recordedAtMs).toISOString(),
      last: roundMetric(samples[samples.length - 1]!.value),
      average: roundMetric(total / values.length),
      p95: roundMetric(nearestRank(values, 0.95)),
      p99: roundMetric(nearestRank(values, 0.99)),
      maximum: roundMetric(values[values.length - 1]!),
    };
  }

  private orderedSamples(): TimedSample[] {
    if (this.sampleCount < this.capacity) {
      return this.samples.slice(0, this.sampleCount) as TimedSample[];
    }
    return [
      ...(this.samples.slice(this.nextIndex) as TimedSample[]),
      ...(this.samples.slice(0, this.nextIndex) as TimedSample[]),
    ];
  }
}

@Injectable()
export class CommercialOcrMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(CommercialOcrMetricsService.name);
  private readonly processStartedAtMs = Date.now();
  private readonly processStartedAt = new Date(this.processStartedAtMs).toISOString();
  private readonly behaviorIdentity: CommercialOcrBehaviorIdentity;
  private readonly behaviorFingerprint: string;
  private readonly behaviorScope: string;
  private readonly releaseKey: string;
  private readonly remoteProcessKey: string;
  private readonly redis: Redis | null;
  private readonly nativeCpuSamplingAvailable: boolean;
  private readonly processCounters = new Map<CommercialOcrMetricCounter, number>();
  private readonly pendingRemoteCounters = new Map<CommercialOcrMetricCounter, number>();
  private inFlightRemoteBatch: RemoteCounterBatch | null = null;
  private nextRemoteBatchSequence = 1;
  private readonly bullMqQueueWaitMs = new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY);
  private readonly stageDurationMs: Record<CommercialOcrStage, BoundedRollingMetric> = {
    source: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    source_wait: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    governor_wait: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    native_wait: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    download: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    preprocess: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    native: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    policy: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    end_to_end: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
    event_to_terminal: new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY),
  };
  private readonly cpuSecondsPerImage = new BoundedRollingMetric(ROLLING_SAMPLE_CAPACITY);
  private unavailableCpuSamples = 0;
  private lastWriteFailureLogAtMs = 0;
  private lastReadFailureLogAtMs = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private aggregateCache: Awaited<
    ReturnType<CommercialOcrMetricsService['readAggregateCounters']>
  > | null = null;
  private aggregateCacheAtMs = 0;
  private shuttingDown = false;

  constructor(@Optional() configService?: ConfigService) {
    this.nativeCpuSamplingAvailable = !configService
      ?.get<string>('COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH')
      ?.trim();
    const productionProducer =
      configService?.get('NODE_ENV') === 'production' &&
      configService?.get('APP_ROLE') === 'moderation' &&
      configService?.get('APP_SERVICE_NAME') !== 'api-media-analysis';
    // Producers do not execute native operations. Use the deployed sandbox profile for their
    // counters so the worker can report admission and completion in the same scope.
    const descriptor = productionProducer
      ? resolveCommercialOcrProductionBehaviorDescriptor(configService)
      : resolveCommercialOcrBehaviorDescriptor(configService);
    this.behaviorIdentity = resolveCommercialOcrBehaviorIdentity(descriptor);
    this.behaviorFingerprint = this.behaviorIdentity.fingerprint;
    this.behaviorScope = this.behaviorIdentity.scope;
    this.releaseKey = `${METRICS_NAMESPACE}:release:${this.behaviorScope}`;
    this.remoteProcessKey = `${METRICS_NAMESPACE}:process:${this.behaviorScope}:${randomUUID()}`;
    const redisUrl = configService?.get<string>('REDIS_URL')?.trim();
    this.redis = redisUrl
      ? new Redis(redisUrl, {
          ...COMMERCIAL_OCR_REDIS_OPTIONS,
          autoResendUnfulfilledCommands: false,
        })
      : null;
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const activeFlush = this.flushPromise;
    if (activeFlush) {
      await activeFlush;
    }
    await this.flushPendingWrites();
    if (!this.redis) {
      return;
    }
    if (this.redis.status === 'ready') {
      await this.redis.quit();
      return;
    }
    this.redis.disconnect();
  }

  recordCounter(counter: CommercialOcrMetricCounter, amount = 1): void {
    if (
      !COMMERCIAL_OCR_METRIC_COUNTER_SET.has(counter) ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > 1_000_000
    ) {
      return;
    }
    this.processCounters.set(counter, (this.processCounters.get(counter) ?? 0) + amount);
    this.aggregateCache = null;
    this.aggregateCacheAtMs = 0;
    if (!this.redis) {
      return;
    }
    this.pendingRemoteCounters.set(
      counter,
      (this.pendingRemoteCounters.get(counter) ?? 0) + amount,
    );
    this.scheduleFlush();
  }

  getProcessTerminalDeadlineExhaustedCounters(): CommercialOcrTerminalDeadlineExhaustedCounters {
    return {
      source_not_ready:
        this.processCounters.get('bullmq.job.deadline_exhausted.source_not_ready') ?? 0,
      governor_pressure:
        this.processCounters.get('bullmq.job.deadline_exhausted.governor_pressure') ?? 0,
      admission_pending:
        this.processCounters.get('bullmq.job.deadline_exhausted.admission_pending') ?? 0,
      native_backpressure:
        this.processCounters.get('bullmq.job.deadline_exhausted.native_backpressure') ?? 0,
    };
  }

  getLogicalRecordingContext(
    job: CommercialOcrJob,
    jobId: string,
    nowMs = Date.now(),
  ): CommercialOcrLogicalRecordingContext {
    return {
      identitySha256: createHash('sha256')
        .update(
          JSON.stringify([
            jobId,
            this.behaviorIdentity.fingerprintSha256,
            resolveCommercialOcrJobPurposes(job),
          ]),
        )
        .digest('hex'),
      releaseKey: this.releaseKey,
      bucketKey: this.buildBucketKey(nowMs),
      startedAtMs: this.processStartedAtMs,
    };
  }

  // FLAG: The admission store has already persisted these counters atomically with the claim. Do not
  // enqueue another remote batch; a worker restart or an uncertain reply cannot double-count it.
  observeLogicalRecording(
    result: CommercialOcrLogicalRecordingResult,
    terminal?: CommercialOcrTerminalResult,
  ): void {
    if (result === 'unavailable' || result === 'missing') {
      this.recordCounter(`logical.accounting.${result}`);
      return;
    }
    if (result !== 'recorded') return;
    const counters: CommercialOcrMetricCounter[] = terminal
      ? [
          'logical.terminal',
          `logical.outcome.${terminal.outcome}`,
          `logical.reason.${terminal.reason}`,
        ]
      : ['logical.started'];
    for (const counter of counters)
      this.processCounters.set(counter, (this.processCounters.get(counter) ?? 0) + 1);
    this.aggregateCache = null;
    this.aggregateCacheAtMs = 0;
  }

  recordQueueWait(waitMs: number, recordedAtMs = Date.now()): void {
    this.bullMqQueueWaitMs.record(waitMs, recordedAtMs);
  }

  recordStageDuration(
    stage: CommercialOcrStage,
    durationMs: number,
    recordedAtMs = Date.now(),
  ): void {
    this.stageDurationMs[stage].record(durationMs, recordedAtMs);
  }

  startImageCpuSample(): CommercialOcrImageCpuSample {
    return {
      startedUsageMicros: this.nativeCpuSamplingAvailable ? this.readCgroupCpuUsageMicros() : null,
      nativePasses: 0,
      finished: false,
    };
  }

  recordNativePass(
    sample: CommercialOcrImageCpuSample,
    durationMs: number,
    recordedAtMs = Date.now(),
  ): void {
    if (sample.finished) {
      return;
    }
    sample.nativePasses += 1;
    this.recordStageDuration('native', durationMs, recordedAtMs);
  }

  finishImageCpuSample(sample: CommercialOcrImageCpuSample, recordedAtMs = Date.now()): void {
    if (sample.finished) {
      return;
    }
    sample.finished = true;
    if (sample.nativePasses === 0) {
      return;
    }

    const finishedUsageMicros = this.readCgroupCpuUsageMicros();
    if (
      sample.startedUsageMicros === null ||
      finishedUsageMicros === null ||
      finishedUsageMicros < sample.startedUsageMicros
    ) {
      this.unavailableCpuSamples += 1;
      return;
    }
    const usedMicros = finishedUsageMicros - sample.startedUsageMicros;
    const cpuSeconds = Number(usedMicros) / 1_000_000;
    this.cpuSecondsPerImage.record(cpuSeconds, recordedAtMs);
  }

  async getSnapshot(nowMs = Date.now()): Promise<CommercialOcrRolloutMetricsSnapshot> {
    const aggregate = await this.getAggregateCounters(nowMs);
    const queueWait = this.bullMqQueueWaitMs.snapshot();
    const stageDurationMs = Object.fromEntries(
      COMMERCIAL_OCR_STAGES.map((stage) => [stage, this.stageDurationMs[stage].snapshot()]),
    ) as Record<CommercialOcrStage, CommercialOcrRollingMetricSnapshot>;
    return {
      behaviorRelease: {
        scope: this.behaviorScope,
        fingerprint: this.behaviorFingerprint,
        fingerprintSha256: this.behaviorIdentity.fingerprintSha256,
        nativeFingerprintSha256: fingerprintCommercialOcrNativeBehaviorManifest(
          this.behaviorIdentity.descriptor.native,
        ),
        nativeBuildManifestSha256: this.behaviorIdentity.descriptor.native.buildManifestSha256,
        nativeIdentityComplete: isCommercialOcrNativeBehaviorManifestComplete(
          this.behaviorIdentity.descriptor.native,
        ),
        nativeRuntimeControls: this.behaviorIdentity.descriptor.native.controls,
        ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
        decisionPolicyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
        detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
        preprocessLimits: this.behaviorIdentity.descriptor.preprocessLimits,
      },
      logicalTerminalCoverage: {
        started: aggregate.release.counters['logical.started'],
        terminal: aggregate.release.counters['logical.terminal'],
        inflightOrUnknown: Math.max(
          0,
          aggregate.release.counters['logical.started'] -
            aggregate.release.counters['logical.terminal'],
        ),
        accountingUnavailable: aggregate.release.counters['logical.accounting.unavailable'],
        accountingMissing: aggregate.release.counters['logical.accounting.missing'],
        complete:
          aggregate.release.available &&
          aggregate.release.counters['logical.accounting.unavailable'] === 0 &&
          aggregate.release.counters['logical.accounting.missing'] === 0 &&
          aggregate.release.counters['logical.started'] ===
            aggregate.release.counters['logical.terminal'],
      },
      processStartedAt: this.processStartedAt,
      processCounters: {
        available: true,
        startedAt: this.processStartedAt,
        generatedAt: new Date(nowMs).toISOString(),
        counters: toCounterValues(this.processCounters),
      },
      releaseCounters: aggregate.release,
      windowCounters: aggregate.window,
      bullMqQueueWaitMs: queueWait,
      queueWaitMs: queueWait,
      stageDurationMs,
      nativePassDurationMs: stageDurationMs.native,
      cpuSecondsPerImage: {
        ...this.cpuSecondsPerImage.snapshot(),
        unavailable: this.unavailableCpuSamples,
        source: 'cgroup',
      },
    };
  }

  async flushPendingWrites(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }
    const batch = this.inFlightRemoteBatch ?? this.takePendingRemoteBatch();
    if (!batch) {
      return;
    }
    this.inFlightRemoteBatch = batch;
    const flush = this.writeCounters(batch)
      .then((written) => {
        if (written && this.inFlightRemoteBatch === batch) {
          this.inFlightRemoteBatch = null;
        }
      })
      .finally(() => {
        if (this.flushPromise === flush) {
          this.flushPromise = null;
        }
        if (this.inFlightRemoteBatch || this.pendingRemoteCounters.size > 0) {
          this.scheduleFlush();
        }
      });
    this.flushPromise = flush;
    await flush;
  }

  protected readCgroupCpuUsageMicros(): bigint | null {
    try {
      const cpuStat = readFileSync(CGROUP_V2_CPU_STAT_PATH, 'utf8');
      const match = /^usage_usec\s+(\d+)$/mu.exec(cpuStat);
      if (match?.[1]) {
        return BigInt(match[1]);
      }
    } catch {
      // Fall through to cgroup v1.
    }

    try {
      const usageNanoseconds = readFileSync(CGROUP_V1_CPU_USAGE_PATH, 'utf8').trim();
      if (/^\d+$/u.test(usageNanoseconds)) {
        return BigInt(usageNanoseconds) / 1_000n;
      }
    } catch {
      return null;
    }
    return null;
  }

  private scheduleFlush(): void {
    if (this.shuttingDown || this.flushTimer || this.flushPromise) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingWrites();
    }, METRICS_FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  private async writeCounters(batch: RemoteCounterBatch): Promise<boolean> {
    const redis = this.redis;
    if (!redis) {
      return true;
    }
    try {
      const result = await redis.eval(
        RECORD_COUNTER_SCRIPT,
        3,
        this.releaseKey,
        batch.bucketKey,
        this.remoteProcessKey,
        String(this.processStartedAtMs),
        String(METRICS_RELEASE_RETENTION_SEC),
        String(METRICS_BUCKET_RETENTION_SEC),
        String(METRICS_BATCH_DEDUPE_RETENTION_SEC),
        String(batch.sequence),
        ...batch.entries.flatMap(([counter, amount]) => [counter, String(amount)]),
      );
      if (result !== 0 && result !== 1) {
        throw new Error('Commercial OCR metrics write returned an invalid result');
      }
      return true;
    } catch {
      this.logWriteFailure();
      return false;
    }
  }

  private takePendingRemoteBatch(): RemoteCounterBatch | null {
    const entries = [...this.pendingRemoteCounters.entries()];
    if (entries.length === 0) {
      return null;
    }
    this.pendingRemoteCounters.clear();
    const batch = {
      sequence: this.nextRemoteBatchSequence,
      bucketKey: this.buildBucketKey(Date.now()),
      entries,
    } satisfies RemoteCounterBatch;
    this.nextRemoteBatchSequence += 1;
    return batch;
  }

  private async getAggregateCounters(
    nowMs: number,
  ): ReturnType<CommercialOcrMetricsService['readAggregateCounters']> {
    await this.flushPendingWrites();
    if (this.aggregateCache && nowMs - this.aggregateCacheAtMs <= METRICS_AGGREGATE_CACHE_MS) {
      return this.aggregateCache;
    }
    const aggregate = await this.readAggregateCounters(nowMs);
    this.aggregateCache = aggregate;
    this.aggregateCacheAtMs = nowMs;
    return aggregate;
  }

  private async readAggregateCounters(nowMs: number): Promise<{
    release: CommercialOcrCounterSnapshot;
    window: CommercialOcrWindowCounterSnapshot;
  }> {
    const windowBounds = resolveWindowBounds(nowMs);
    const unavailable = {
      release: this.emptyReleaseSnapshot(false, nowMs),
      window: this.emptyWindowSnapshot(false, nowMs, windowBounds),
    };
    const redis = this.redis;
    if (!redis) {
      return unavailable;
    }

    try {
      const pipeline = redis.pipeline();
      pipeline.hgetall(this.releaseKey);
      for (const key of this.buildWindowKeys(windowBounds)) {
        pipeline.hgetall(key);
      }
      const results = await pipeline.exec();
      if (!results || results.length !== windowBounds.bucketCount + 1) {
        throw new Error('Commercial OCR metrics pipeline returned an invalid result');
      }
      const rows = results.map(([error, value]) => {
        if (error || !isStringRecord(value)) {
          throw error ?? new Error('Commercial OCR metrics row is invalid');
        }
        return value;
      });
      const releaseRow = rows[0] ?? {};
      const windowRows = rows.slice(1);
      return {
        release: {
          available: true,
          startedAt: readTimestamp(releaseRow.started_at_ms),
          generatedAt: new Date(nowMs).toISOString(),
          counters: aggregateCounterRows([releaseRow]),
        },
        window: {
          available: true,
          startedAt: null,
          generatedAt: new Date(nowMs).toISOString(),
          counters: aggregateCounterRows(windowRows),
          windowSec: METRICS_WINDOW_SEC,
          bucketSpanSec: METRICS_BUCKET_SPAN_SEC,
          windowStartAt: new Date(windowBounds.windowStartMs).toISOString(),
          windowEndAt: new Date(nowMs).toISOString(),
        },
      };
    } catch {
      this.logReadFailure();
      return unavailable;
    }
  }

  private emptyReleaseSnapshot(available: boolean, nowMs: number): CommercialOcrCounterSnapshot {
    return {
      available,
      startedAt: null,
      generatedAt: new Date(nowMs).toISOString(),
      counters: emptyCounterValues(),
    };
  }

  private emptyWindowSnapshot(
    available: boolean,
    nowMs: number,
    bounds: ReturnType<typeof resolveWindowBounds>,
  ): CommercialOcrWindowCounterSnapshot {
    return {
      available,
      startedAt: null,
      generatedAt: new Date(nowMs).toISOString(),
      counters: emptyCounterValues(),
      windowSec: METRICS_WINDOW_SEC,
      bucketSpanSec: METRICS_BUCKET_SPAN_SEC,
      windowStartAt: new Date(bounds.windowStartMs).toISOString(),
      windowEndAt: new Date(nowMs).toISOString(),
    };
  }

  private buildBucketKey(nowMs: number): string {
    const bucket = Math.floor(nowMs / (METRICS_BUCKET_SPAN_SEC * 1_000));
    return `${METRICS_NAMESPACE}:window:${this.behaviorScope}:${bucket}`;
  }

  private buildWindowKeys(bounds: ReturnType<typeof resolveWindowBounds>): string[] {
    return Array.from({ length: bounds.bucketCount }, (_, index) => {
      const bucket = bounds.firstBucket + index;
      return `${METRICS_NAMESPACE}:window:${this.behaviorScope}:${bucket}`;
    });
  }

  private logWriteFailure(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastWriteFailureLogAtMs < METRICS_FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastWriteFailureLogAtMs = nowMs;
    this.logger.warn('Commercial OCR metrics write failed; moderation was not affected');
  }

  private logReadFailure(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastReadFailureLogAtMs < METRICS_FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastReadFailureLogAtMs = nowMs;
    this.logger.warn('Commercial OCR aggregate metrics are temporarily unavailable');
  }
}

const COMMERCIAL_OCR_STAGES: readonly CommercialOcrStage[] = [
  'source',
  'source_wait',
  'governor_wait',
  'native_wait',
  'download',
  'preprocess',
  'native',
  'policy',
  'end_to_end',
  'event_to_terminal',
];
const COMMERCIAL_OCR_METRIC_COUNTER_SET = new Set<string>(COMMERCIAL_OCR_METRIC_COUNTERS);

function resolveWindowBounds(nowMs: number): {
  firstBucket: number;
  bucketCount: number;
  windowStartMs: number;
} {
  const bucketSpanMs = METRICS_BUCKET_SPAN_SEC * 1_000;
  const currentBucket = Math.floor(nowMs / bucketSpanMs);
  const firstBucket = Math.floor((nowMs - METRICS_WINDOW_SEC * 1_000) / bucketSpanMs);
  const bucketCount = currentBucket - firstBucket + 1;
  return {
    firstBucket,
    bucketCount,
    windowStartMs: firstBucket * bucketSpanMs,
  };
}

function aggregateCounterRows(rows: ReadonlyArray<Record<string, string>>): CounterValues {
  const totals = new Map<CommercialOcrMetricCounter, number>();
  for (const row of rows) {
    for (const counter of COMMERCIAL_OCR_METRIC_COUNTERS) {
      const value = readCounter(row[`counter:${counter}`]);
      if (value > 0) {
        totals.set(counter, (totals.get(counter) ?? 0) + value);
      }
    }
  }
  return toCounterValues(totals);
}

function toCounterValues(values: ReadonlyMap<CommercialOcrMetricCounter, number>): CounterValues {
  return Object.fromEntries(
    COMMERCIAL_OCR_METRIC_COUNTERS.map((counter) => [counter, values.get(counter) ?? 0]),
  ) as Record<CommercialOcrMetricCounter, number>;
}

function emptyCounterValues(): CounterValues {
  return toCounterValues(new Map());
}

function readCounter(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function readTimestamp(value: string | undefined): string | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nearestRank(sortedValues: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index]!;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
