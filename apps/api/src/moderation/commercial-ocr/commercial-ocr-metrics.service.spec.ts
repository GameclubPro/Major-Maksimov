import { ConfigService } from '@nestjs/config';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const mockRedisEval = jest.fn();
const mockRedisQuit = jest.fn().mockResolvedValue('OK');
const mockRedisDisconnect = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    status: 'ready',
    eval: mockRedisEval,
    quit: mockRedisQuit,
    disconnect: mockRedisDisconnect,
  })),
}));

import {
  COMMERCIAL_OCR_BEHAVIOR_DESCRIPTOR,
  COMMERCIAL_OCR_DETECTOR_SOURCE_IDENTITY,
  resolveCommercialOcrBehaviorDescriptor,
  resolveCommercialOcrBehaviorIdentity,
} from './commercial-ocr-behavior-identity';
import {
  COMMERCIAL_OCR_METRIC_COUNTERS,
  CommercialOcrMetricsService,
} from './commercial-ocr-metrics.service';

class TestCommercialOcrMetricsService extends CommercialOcrMetricsService {
  private readonly cpuReadings: Array<bigint | null> = [];

  queueCpuReadings(...readings: Array<bigint | null>): void {
    this.cpuReadings.push(...readings);
  }

  protected override readCgroupCpuUsageMicros(): bigint | null {
    return this.cpuReadings.shift() ?? null;
  }
}

describe('CommercialOcrMetricsService', () => {
  beforeEach(() => {
    mockRedisEval.mockReset();
    mockRedisQuit.mockClear();
    mockRedisDisconnect.mockClear();
  });

  it('keeps committed logical counters separate from remote batching and exposes unknown coverage', async () => {
    const service = new TestCommercialOcrMetricsService();
    service.observeLogicalRecording('recorded');
    service.observeLogicalRecording('recorded', {
      outcome: 'TECHNICAL_INCOMPLETE',
      reason: 'source_unavailable',
    });
    service.observeLogicalRecording('duplicate', {
      outcome: 'TECHNICAL_INCOMPLETE',
      reason: 'source_unavailable',
    });
    service.observeLogicalRecording('unavailable');
    const snapshot = await service.getSnapshot();
    expect(snapshot.processCounters.counters['logical.started']).toBe(1);
    expect(snapshot.processCounters.counters['logical.terminal']).toBe(1);
    expect(snapshot.processCounters.counters['logical.outcome.TECHNICAL_INCOMPLETE']).toBe(1);
    expect(snapshot.processCounters.counters['logical.accounting.unavailable']).toBe(1);
    expect(snapshot.logicalTerminalCoverage.complete).toBe(false);
    expect(mockRedisEval).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('reports nearest-rank percentiles from a bounded rolling BullMQ window', async () => {
    const service = new TestCommercialOcrMetricsService();
    const startedAtMs = Date.parse('2026-08-13T10:00:00.000Z');

    for (let value = 1; value <= 600; value += 1) {
      service.recordQueueWait(value, startedAtMs + value);
    }

    const snapshot = await service.getSnapshot(startedAtMs + 1_000);
    expect(snapshot.bullMqQueueWaitMs).toEqual({
      observed: 600,
      sampled: 512,
      capacity: 512,
      oldestSampleAt: new Date(startedAtMs + 89).toISOString(),
      newestSampleAt: new Date(startedAtMs + 600).toISOString(),
      last: 600,
      average: 344.5,
      p95: 575,
      p99: 595,
      maximum: 600,
    });
    expect(snapshot.queueWaitMs).toEqual(snapshot.bullMqQueueWaitMs);
  });

  it('records native pass duration and cgroup CPU once per attempted image', async () => {
    const service = new TestCommercialOcrMetricsService();
    service.queueCpuReadings(1_000_000n, 3_250_000n);
    const image = service.startImageCpuSample();

    service.recordNativePass(image, 125.1236, 1_000);
    service.recordNativePass(image, 250, 2_000);
    service.finishImageCpuSample(image, 3_000);
    service.finishImageCpuSample(image, 4_000);

    const snapshot = await service.getSnapshot(5_000);
    expect(snapshot.nativePassDurationMs).toMatchObject({
      observed: 2,
      sampled: 2,
      last: 250,
      average: 187.562,
      p95: 250,
      p99: 250,
    });
    expect(snapshot.stageDurationMs.native).toEqual(snapshot.nativePassDurationMs);
    expect(snapshot.cpuSecondsPerImage).toMatchObject({
      observed: 1,
      sampled: 1,
      last: 2.25,
      average: 2.25,
      p95: 2.25,
      p99: 2.25,
      unavailable: 0,
      source: 'cgroup',
    });
  });

  it('does not count cache-only images and exposes unsupported cgroup samples', async () => {
    const service = new TestCommercialOcrMetricsService();
    service.queueCpuReadings(null, 10n, null);

    const cacheOnly = service.startImageCpuSample();
    service.finishImageCpuSample(cacheOnly);
    const attempted = service.startImageCpuSample();
    service.recordNativePass(attempted, 10);
    service.finishImageCpuSample(attempted);

    await expect(service.getSnapshot()).resolves.toMatchObject({
      cpuSecondsPerImage: {
        observed: 0,
        sampled: 0,
        unavailable: 1,
      },
    });
  });

  it('marks native CPU samples unavailable when OCR runs in the sidecar cgroup', async () => {
    const service = new TestCommercialOcrMetricsService(
      new ConfigService({
        COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/native-ocr.sock',
      }),
    );
    service.queueCpuReadings(1_000_000n, 2_000_000n);
    const image = service.startImageCpuSample();

    service.recordNativePass(image, 10);
    service.finishImageCpuSample(image);

    await expect(service.getSnapshot()).resolves.toMatchObject({
      cpuSecondsPerImage: { observed: 0, sampled: 0, unavailable: 1 },
    });
  });

  it('exposes only fixed privacy-safe counters scoped to the behavior release', async () => {
    const service = new TestCommercialOcrMetricsService();
    service.recordCounter('analysis.complete.delete');
    service.recordCounter('analysis.complete.delete', 2);
    service.recordCounter('analysis.incomplete.ocr_timeout');
    service.recordCounter('bullmq.job.deadline_exhausted.governor_pressure', 2);

    const snapshot = await service.getSnapshot(Date.parse('2026-08-14T10:00:00.000Z'));

    expect(snapshot.behaviorRelease).toEqual({
      scope: expect.stringMatching(/^tesseract-rus-eng-v2:[a-f0-9]{24}$/u),
      fingerprint: expect.stringMatching(/^[a-f0-9]{24}$/u),
      fingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ocrVersion: 'tesseract-rus-eng-v2',
      decisionPolicyVersion: 'commercial-ocr-delete-policy-v2',
      detectorSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      nativeFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      nativeBuildManifestSha256: null,
      nativeIdentityComplete: false,
      nativeRuntimeControls: {
        timeoutMs: 10_000,
        concurrency: 1,
        maxQueue: 16,
        recycleAfterJobs: 250,
        maxSourceImageBytes: 16 * 1024 * 1024,
        maxImageBytes: 16 * 1024 * 1024,
        maxOutputBytes: 4 * 1024 * 1024,
        maxInputPixels: 40_000_000,
        maxOutputPixels: 3_000_000,
        maxSide: 2_000,
        ompThreadLimit: 1,
        sharpConcurrency: 1,
        sharpProcessingTimeoutSeconds: 5,
      },
      preprocessLimits: {
        maxInputPixels: 40_000_000,
        maxOutputPixels: 3_000_000,
        maxSide: 2_000,
      },
    });
    expect(Object.keys(snapshot.processCounters.counters)).toEqual(COMMERCIAL_OCR_METRIC_COUNTERS);
    expect(snapshot.processCounters.counters['analysis.complete.delete']).toBe(3);
    expect(snapshot.processCounters.counters['analysis.incomplete.ocr_timeout']).toBe(1);
    expect(service.getProcessTerminalDeadlineExhaustedCounters()).toEqual({
      source_not_ready: 0,
      governor_pressure: 2,
      admission_pending: 0,
      native_backpressure: 0,
    });
    expect(snapshot.releaseCounters.available).toBe(false);
    expect(snapshot.windowCounters).toMatchObject({
      available: false,
      windowSec: 86_400,
      bucketSpanSec: 900,
    });
    const serialized = JSON.stringify(snapshot);
    for (const privateField of ['chatId', 'messageId', 'userId', 'url', 'text', 'pixels']) {
      expect(serialized).not.toContain(`"${privateField}"`);
    }
  });

  it('changes behavior identity when preprocessing or detector source identity changes', () => {
    const baseline = resolveCommercialOcrBehaviorIdentity();
    const changedPreprocessing = resolveCommercialOcrBehaviorIdentity({
      ...COMMERCIAL_OCR_BEHAVIOR_DESCRIPTOR,
      preprocessProfiles: {
        ...COMMERCIAL_OCR_BEHAVIOR_DESCRIPTOR.preprocessProfiles,
        primary: 'gray-bounded-v-next',
      },
    });
    const changedDetector = resolveCommercialOcrBehaviorIdentity({
      ...COMMERCIAL_OCR_BEHAVIOR_DESCRIPTOR,
      detector: {
        ...COMMERCIAL_OCR_BEHAVIOR_DESCRIPTOR.detector,
        sourceIdentity: { implementation: 'commercial-detector-source-next' },
      },
    });

    expect(changedPreprocessing.fingerprint).not.toBe(baseline.fingerprint);
    expect(changedDetector.fingerprint).not.toBe(baseline.fingerprint);
    expect(resolveCommercialOcrBehaviorIdentity()).toEqual(baseline);
  });

  it('binds the behavior release to detector source content and effective preprocessing limits', async () => {
    execFileSync(process.execPath, [
      resolve(__dirname, '../../../../../scripts/generate-commercial-ocr-detector-source.mjs'),
      '--check',
    ]);
    expect(COMMERCIAL_OCR_DETECTOR_SOURCE_IDENTITY).toMatchObject({
      digestKind: 'SOURCE_FILES',
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceFileCount: expect.any(Number),
    });

    const baseline = resolveCommercialOcrBehaviorIdentity(resolveCommercialOcrBehaviorDescriptor());
    const tunedDescriptor = resolveCommercialOcrBehaviorDescriptor(
      new ConfigService({
        COMMERCIAL_OCR_MAX_INPUT_PIXELS: 20_000_000,
        COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: 2_000_000,
        COMMERCIAL_OCR_MAX_SIDE: 1_600,
      }),
    );
    const tuned = resolveCommercialOcrBehaviorIdentity(tunedDescriptor);
    const service = new TestCommercialOcrMetricsService(
      new ConfigService({
        COMMERCIAL_OCR_MAX_INPUT_PIXELS: 20_000_000,
        COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: 2_000_000,
        COMMERCIAL_OCR_MAX_SIDE: 1_600,
      }),
    );

    expect(tuned.fingerprint).not.toBe(baseline.fingerprint);
    await expect(service.getSnapshot()).resolves.toMatchObject({
      behaviorRelease: {
        fingerprint: tuned.fingerprint,
        preprocessLimits: tunedDescriptor.preprocessLimits,
      },
    });
  });

  it('puts production producer and media counters in the same behavior scope', async () => {
    const common = { NODE_ENV: 'production', APP_ROLE: 'moderation' };
    const producer = new TestCommercialOcrMetricsService(
      new ConfigService({
        ...common,
        APP_SERVICE_NAME: 'api-moderation-realtime-b',
        COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: 16,
      }),
    );
    const media = new TestCommercialOcrMetricsService(
      new ConfigService({
        ...common,
        APP_SERVICE_NAME: 'api-media-analysis',
        COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: 4,
      }),
    );
    const changedMedia = new TestCommercialOcrMetricsService(
      new ConfigService({
        ...common,
        APP_SERVICE_NAME: 'api-media-analysis',
        COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: 2,
      }),
    );

    const [producerSnapshot, mediaSnapshot, changedMediaSnapshot] = await Promise.all(
      [producer, media, changedMedia].map((service) => service.getSnapshot()),
    );

    expect(producerSnapshot.behaviorRelease).toEqual(mediaSnapshot.behaviorRelease);
    expect(changedMediaSnapshot.behaviorRelease.scope).not.toBe(
      mediaSnapshot.behaviorRelease.scope,
    );
  });

  it('retries an ambiguous Redis batch with the same idempotency fence', async () => {
    const appliedBatches = new Set<string>();
    let remoteDeleteCount = 0;
    mockRedisEval.mockImplementation(async (...args: unknown[]) => {
      const processKey = String(args[4]);
      const sequence = String(args[9]);
      const batchIdentity = `${processKey}:${sequence}`;
      if (!appliedBatches.has(batchIdentity)) {
        appliedBatches.add(batchIdentity);
        const counterArgs = args.slice(10);
        for (let index = 0; index < counterArgs.length; index += 2) {
          if (counterArgs[index] === 'analysis.complete.delete') {
            remoteDeleteCount += Number(counterArgs[index + 1]);
          }
        }
      }
      if (mockRedisEval.mock.calls.length === 1) {
        throw new Error('ambiguous Redis response');
      }
      return appliedBatches.size;
    });
    const service = new TestCommercialOcrMetricsService(
      new ConfigService({ REDIS_URL: 'redis://metrics.test:6379' }),
    );
    service.recordCounter('analysis.complete.delete', 3);

    await service.flushPendingWrites();
    service.recordCounter('analysis.incomplete.ocr_timeout');
    await service.flushPendingWrites();

    expect(mockRedisEval).toHaveBeenCalledTimes(2);
    expect(mockRedisEval.mock.calls[1]?.[4]).toBe(mockRedisEval.mock.calls[0]?.[4]);
    expect(mockRedisEval.mock.calls[1]?.[9]).toBe(mockRedisEval.mock.calls[0]?.[9]);
    expect(mockRedisEval.mock.calls[1]?.slice(10)).toEqual(mockRedisEval.mock.calls[0]?.slice(10));
    expect(remoteDeleteCount).toBe(3);

    await service.flushPendingWrites();
    expect(mockRedisEval).toHaveBeenCalledTimes(3);
    expect(mockRedisEval.mock.calls[2]?.[9]).toBe('2');
    expect(mockRedisEval.mock.calls[2]?.slice(10)).toEqual([
      'analysis.incomplete.ocr_timeout',
      '1',
    ]);
    await service.onModuleDestroy();
  });

  it('performs one bounded final flush when Redis remains unavailable during shutdown', async () => {
    mockRedisEval.mockRejectedValue(new Error('Redis unavailable'));
    const service = new TestCommercialOcrMetricsService(
      new ConfigService({ REDIS_URL: 'redis://metrics.test:6379' }),
    );
    service.recordCounter('analysis.complete.no_action');

    await service.onModuleDestroy();

    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
  });
});
