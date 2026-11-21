import type { NativeOcrSandboxPool } from './native-ocr-sandbox.pool';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  createCommercialOcrNativeBehaviorIdentity,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionNativeConfigReader,
  type CommercialOcrNativeArtifactVerification,
  type CommercialOcrNativeBehaviorIdentity,
} from './commercial-ocr-behavior-identity';
import { NativeTesseractOcrAdapter } from './native-tesseract-ocr.adapter';
import {
  NativeOcrSandboxRequestError,
  NativeOcrSandboxRequestTimeoutError,
  NativeOcrSandboxUnavailableError,
} from './native-ocr-sandbox.client';
import type {
  NativeTesseractWorkerRequest,
  NativeTesseractWorkerResponse,
} from './native-tesseract-worker.protocol';

class FakeWorker extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly requests: NativeTesseractWorkerRequest[] = [];
  readonly killSignals: NodeJS.Signals[] = [];
  onRequest?: (request: NativeTesseractWorkerRequest) => void;
  sendError: Error | null = null;

  constructor(autoReady = true) {
    super();
    if (autoReady) {
      queueMicrotask(() =>
        this.emit('message', { type: 'ready' } satisfies NativeTesseractWorkerResponse),
      );
    }
  }

  send(request: NativeTesseractWorkerRequest, callback?: (error: Error | null) => void): boolean {
    this.requests.push(request);
    queueMicrotask(() => {
      callback?.(this.sendError);
      this.onRequest?.(request);
    });
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    this.connected = false;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }

  respond(jobId: string, text = 'Ремонт окон'): void {
    this.emit('message', {
      type: 'result',
      jobId,
      retireWorker: false,
      result: {
        ok: true,
        payload: {
          text,
          aggregateConfidence: text ? 91 : null,
          words: text
            ? [
                {
                  text,
                  start: 0,
                  end: text.length,
                  confidence: 91,
                  lineIndex: 0,
                  boundingBox: { left: 0, top: 0, width: 100, height: 20 },
                },
              ]
            : [],
          lines: text
            ? [
                {
                  text,
                  start: 0,
                  end: text.length,
                  confidence: 91,
                  wordStartIndex: 0,
                  wordEndIndex: 1,
                  boundingBox: { left: 0, top: 0, width: 100, height: 20 },
                },
              ]
            : [],
          truncated: false,
        },
      },
    } satisfies NativeTesseractWorkerResponse);
  }

  fail(
    jobId: string,
    reason: 'timeout' | 'tesseract_failed' | 'output_limit' | 'invalid_output',
    retireWorker = false,
  ): void {
    this.emit('message', {
      type: 'result',
      jobId,
      retireWorker,
      result: { ok: false, reason },
    } satisfies NativeTesseractWorkerResponse);
  }
}

class StubbornFakeWorker extends FakeWorker {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

class TestNativeTesseractOcrAdapter extends NativeTesseractOcrAdapter {
  readonly workers: FakeWorker[] = [];
  readonly workerEnvironments: NodeJS.ProcessEnv[] = [];

  constructor(
    configService: ConfigService,
    private readonly autoReady = true,
  ) {
    super(configService);
  }

  protected override forkWorker(_path: string, options: Parameters<typeof fork>[2]): ChildProcess {
    const worker = new FakeWorker(this.autoReady);
    this.workers.push(worker);
    this.workerEnvironments.push(options?.env ?? {});
    return worker as unknown as ChildProcess;
  }
}

class TestStubbornNativeTesseractOcrAdapter extends NativeTesseractOcrAdapter {
  readonly worker = new StubbornFakeWorker();

  protected override forkWorker(): ChildProcess {
    return this.worker as unknown as ChildProcess;
  }
}

class VerificationGatedNativeTesseractOcrAdapter extends TestNativeTesseractOcrAdapter {
  constructor(
    configService: ConfigService,
    private readonly verification: () => Promise<CommercialOcrNativeArtifactVerification>,
    identity: CommercialOcrNativeBehaviorIdentity,
  ) {
    super(configService);
    Object.defineProperty(this, 'nativeBehaviorIdentity', {
      configurable: true,
      value: identity,
    });
  }

  protected override verifyNativeBehaviorIdentity(): Promise<CommercialOcrNativeArtifactVerification> {
    return this.verification();
  }
}

describe('NativeTesseractOcrAdapter', () => {
  const services: TestNativeTesseractOcrAdapter[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.onModuleDestroy()));
  });

  it('preserves the pass label and permits only the bounded PSM set', async () => {
    const service = createService();
    services.push(service);
    const recognition = service.recognize(Buffer.from('image'), {
      psm: 6,
      passLabel: 'confirmation:binary',
    });
    const worker = await readyWorker(service, 0);
    const request = await recognizeRequest(worker);
    expect(request).toMatchObject({ psm: 6 });
    worker.respond(request.jobId);

    await expect(recognition).resolves.toMatchObject({
      ok: true,
      status: 'recognized',
      psm: 6,
      passLabel: 'confirmation:binary',
      aggregateConfidence: 91,
    });
    await expect(
      service.recognize(Buffer.from('image'), {
        psm: 3 as 6,
        passLabel: 'invalid label with spaces',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_input' });
    expect(service.getRuntimeStatus().counters).toMatchObject({
      completed: 1,
      failed: 1,
      failuresByReason: { invalid_input: 1 },
    });
  });

  it('propagates all native resource ceilings to the worker environment', async () => {
    const service = createService({
      OMP_THREAD_LIMIT: 2,
      COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: 2_000_000,
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 1_750,
    });
    services.push(service);
    service.onModuleInit();
    await readyWorker(service, 0);

    expect(service.workerEnvironments[0]).toMatchObject({
      OMP_THREAD_LIMIT: '2',
      COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: '2000000',
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '1750',
    });
  });

  it('does not spawn or dispatch before verification, then starts and recycles after success', async () => {
    const config = new ConfigService({
      APP_SERVICE_NAME: 'api-media-analysis',
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000,
      COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: 1,
    });
    const identity = completeNativeIdentity(config);
    const pending = deferred<CommercialOcrNativeArtifactVerification>();
    const service = new VerificationGatedNativeTesseractOcrAdapter(
      config,
      () => pending.promise,
      identity,
    );
    services.push(service);

    service.onModuleInit();
    expect(service.workers).toHaveLength(0);
    await expect(service.recognize(Buffer.from('pending'))).resolves.toMatchObject({
      ok: false,
      status: 'failed_open',
      reason: 'artifact_unverified',
    });
    expect(service.workers).toHaveLength(0);
    expect(service.getRuntimeStatus()).toMatchObject({
      state: 'starting',
      ready: false,
      behaviorIdentity: { state: 'pending', verified: false },
    });

    pending.resolve(verifiedNativeIdentity(identity));
    const firstWorker = await readyWorker(service, 0);
    const recognition = service.recognize(Buffer.from('verified'));
    const request = await recognizeRequest(firstWorker);
    firstWorker.respond(request.jobId);
    await expect(recognition).resolves.toMatchObject({ ok: true });

    const replacement = await readyWorker(service, 1);
    expect(replacement).not.toBe(firstWorker);
    expect(service.getRuntimeStatus()).toMatchObject({
      ready: true,
      counters: {
        completed: 1,
        failed: 1,
        recycles: 1,
        failuresByReason: { artifact_unverified: 1 },
      },
      behaviorIdentity: { state: 'verified', verified: true },
    });
  });

  it('keeps failed artifact verification fail-open without spawning workers or retrying per job', async () => {
    const config = new ConfigService({
      APP_SERVICE_NAME: 'api-media-analysis',
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000,
    });
    const identity = completeNativeIdentity(config);
    const verify = jest.fn(async () => ({
      ...verifiedNativeIdentity(identity),
      verified: false as const,
      status: 'mismatch' as const,
      mismatches: ['tesseract.binarySha256'],
    }));
    const service = new VerificationGatedNativeTesseractOcrAdapter(config, verify, identity);
    services.push(service);

    service.onModuleInit();
    await waitFor(() =>
      service.getRuntimeStatus().behaviorIdentity.state === 'failed' ? true : undefined,
    );
    await expect(service.recognize(Buffer.from('drifted'))).resolves.toMatchObject({
      ok: false,
      status: 'failed_open',
      reason: 'artifact_unverified',
    });
    await expect(service.recognize(Buffer.from('drifted-again'))).resolves.toMatchObject({
      ok: false,
      status: 'failed_open',
      reason: 'artifact_unverified',
    });

    expect(service.workers).toHaveLength(0);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(service.getRuntimeStatus()).toMatchObject({
      state: 'degraded',
      ready: false,
      counters: {
        completed: 0,
        failed: 2,
        failuresByReason: { artifact_unverified: 2 },
      },
      behaviorIdentity: {
        state: 'failed',
        verified: false,
        mismatchFields: ['tesseract.binarySha256'],
      },
    });
  });

  it('retries a restart probe outage without native work until a fresh exact sandbox probe succeeds', async () => {
    jest.useFakeTimers();
    const { service, sandbox, identity } = createIsolatedSandboxService();
    const probe = jest.spyOn(sandbox, 'probe').mockResolvedValue(verifiedNativeIdentity(identity));
    let boundaryVerified = true;
    const status = sandbox.getStatus();
    jest.spyOn(sandbox, 'getStatus').mockImplementation(() => ({
      ...status,
      verified: boundaryVerified,
    }));
    const recognize = jest
      .spyOn(sandbox, 'recognize')
      .mockResolvedValueOnce({ ok: false, reason: 'timeout' })
      .mockResolvedValue(emptySandboxRecognition());

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(service.getRuntimeStatus().ready).toBe(true);
      await expect(service.recognize(Buffer.from('before restart'))).resolves.toMatchObject({
        ok: false,
        reason: 'timeout',
      });

      probe.mockRejectedValue(new NativeOcrSandboxUnavailableError('unavailable'));
      boundaryVerified = false;
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(service.recognize(Buffer.from('during restart'))).resolves.toMatchObject({
        ok: false,
        reason: 'worker_unavailable',
      });
      await expect(service.recognize(Buffer.from('awaiting exact probe'))).resolves.toMatchObject({
        ok: false,
        reason: 'worker_unavailable',
      });
      expect(recognize).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(service.workers).toHaveLength(0);
      expect(service.getRuntimeStatus()).toMatchObject({
        ready: false,
        behaviorIdentity: { verified: false, mismatchFields: ['boundary.unavailable'] },
      });

      probe.mockResolvedValue(verifiedNativeIdentity(identity));
      boundaryVerified = true;
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(service.recognize(Buffer.from('recovered'))).resolves.toMatchObject({
        ok: true,
        status: 'no_text',
      });
      expect(recognize).toHaveBeenCalledTimes(2);
      expect(service.getRuntimeStatus()).toMatchObject({
        ready: true,
        behaviorIdentity: { verified: true, mismatchFields: [] },
        counters: {
          completed: 1,
          failed: 3,
          failuresByReason: { timeout: 1, worker_unavailable: 2 },
        },
      });
      expect(service.workers).toHaveLength(0);
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('keeps the initial isolated sandbox transport outage retryable until exact verification', async () => {
    jest.useFakeTimers();
    const { service, sandbox, identity } = createIsolatedSandboxService();
    const probe = jest
      .spyOn(sandbox, 'probe')
      .mockRejectedValue(new NativeOcrSandboxUnavailableError('unavailable'));
    const recognize = jest.spyOn(sandbox, 'recognize').mockResolvedValue(emptySandboxRecognition());

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      await expect(service.recognize(Buffer.from('initial outage'))).resolves.toMatchObject({
        ok: false,
        reason: 'worker_unavailable',
      });
      expect(recognize).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(1);

      probe.mockResolvedValue(verifiedNativeIdentity(identity));
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(service.recognize(Buffer.from('verified'))).resolves.toMatchObject({ ok: true });
      expect(recognize).toHaveBeenCalledTimes(1);
      expect(service.workers).toHaveLength(0);
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it.each(['unverified', 'invalid_response', 'unconfigured'] as const)(
    'makes a %s probe failure terminal after a transient outage without native work',
    async (reason) => {
      jest.useFakeTimers();
      const { service, sandbox } = createIsolatedSandboxService();
      const probe = jest
        .spyOn(sandbox, 'probe')
        .mockRejectedValue(new NativeOcrSandboxUnavailableError('unavailable'));
      const recognize = jest.spyOn(sandbox, 'recognize');

      try {
        service.onModuleInit();
        await jest.advanceTimersByTimeAsync(0);
        await expect(service.recognize(Buffer.from('transport outage'))).resolves.toMatchObject({
          ok: false,
          reason: 'worker_unavailable',
        });

        probe.mockRejectedValue(new NativeOcrSandboxUnavailableError(reason));
        await jest.advanceTimersByTimeAsync(5_000);
        await expect(service.recognize(Buffer.from('untrusted sandbox'))).resolves.toMatchObject({
          ok: false,
          reason: 'artifact_unverified',
        });
        await expect(service.recognize(Buffer.from('still untrusted'))).resolves.toMatchObject({
          ok: false,
          reason: 'artifact_unverified',
        });
        expect(probe).toHaveBeenCalledTimes(2);
        expect(recognize).not.toHaveBeenCalled();
        expect(service.workers).toHaveLength(0);
        expect(service.getRuntimeStatus().behaviorIdentity).toMatchObject({
          verified: false,
          mismatchFields: [`boundary.${reason}`],
        });
      } finally {
        await service.onModuleDestroy();
        jest.useRealTimers();
      }
    },
  );

  it.each(['mismatch', 'incomplete', 'unknown'] as const)(
    'makes a %s verification terminal after a transient outage',
    async (failure) => {
      jest.useFakeTimers();
      const { service, sandbox, identity } = createIsolatedSandboxService();
      const probe = jest
        .spyOn(sandbox, 'probe')
        .mockRejectedValue(new NativeOcrSandboxUnavailableError('unavailable'));
      const recognize = jest.spyOn(sandbox, 'recognize');

      try {
        service.onModuleInit();
        await jest.advanceTimersByTimeAsync(0);
        await expect(service.recognize(Buffer.from('outage'))).resolves.toMatchObject({
          reason: 'worker_unavailable',
        });
        if (failure === 'unknown') {
          probe.mockRejectedValue(new Error('unclassified probe failure'));
        } else {
          probe.mockResolvedValue(
            verifiedNativeIdentity({
              ...identity,
              ...(failure === 'mismatch'
                ? { fingerprintSha256: '9'.repeat(64) }
                : { complete: false }),
            }),
          );
        }
        await jest.advanceTimersByTimeAsync(5_000);
        await expect(service.recognize(Buffer.from('invalid verification'))).resolves.toMatchObject(
          {
            ok: false,
            reason: 'artifact_unverified',
          },
        );
        expect(recognize).not.toHaveBeenCalled();
        expect(service.workers).toHaveLength(0);
      } finally {
        await service.onModuleDestroy();
        jest.useRealTimers();
      }
    },
  );

  it.each([
    { label: 'local native probe', config: {} },
    {
      label: 'optional sandbox',
      config: { COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/native-ocr.sock' },
    },
  ])('keeps a $label outage terminal without native work', async ({ config: overrides }) => {
    const config = new ConfigService({
      NODE_ENV: 'test',
      APP_SERVICE_NAME: 'api-media-analysis',
      ...overrides,
    });
    const verify = jest.fn(async () => {
      throw new NativeOcrSandboxUnavailableError('unavailable');
    });
    const service = new VerificationGatedNativeTesseractOcrAdapter(
      config,
      verify,
      completeNativeIdentity(config),
    );
    services.push(service);
    service.onModuleInit();
    await waitFor(() =>
      service.getRuntimeStatus().behaviorIdentity.state === 'failed' ? true : undefined,
    );

    await expect(service.recognize(Buffer.from('unverified'))).resolves.toMatchObject({
      ok: false,
      reason: 'artifact_unverified',
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(service.workers).toHaveLength(0);
  });

  it('keeps an incomplete expected identity terminal during a transport outage', async () => {
    jest.useFakeTimers();
    const { service, sandbox, identity } = createIsolatedSandboxService();
    Object.defineProperty(service, 'nativeBehaviorIdentity', {
      configurable: true,
      value: { ...identity, complete: false },
    });
    jest
      .spyOn(sandbox, 'probe')
      .mockRejectedValue(new NativeOcrSandboxUnavailableError('unavailable'));
    const recognize = jest.spyOn(sandbox, 'recognize');

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      await expect(service.recognize(Buffer.from('incomplete identity'))).resolves.toMatchObject({
        ok: false,
        reason: 'artifact_unverified',
      });
      expect(recognize).not.toHaveBeenCalled();
      expect(service.workers).toHaveLength(0);
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it.each(['capacity_exhausted', 'request_deadline_exceeded'] as const)(
    'preserves verified identity after an ordinary %s request rejection',
    async (reason) => {
      const { service, sandbox, identity } = createIsolatedSandboxService();
      jest.spyOn(sandbox, 'probe').mockResolvedValue(verifiedNativeIdentity(identity));
      const recognize = jest
        .spyOn(sandbox, 'recognize')
        .mockRejectedValueOnce(new NativeOcrSandboxRequestError(reason))
        .mockResolvedValueOnce(emptySandboxRecognition());
      try {
        service.onModuleInit();
        await waitFor(() =>
          service.getRuntimeStatus().behaviorIdentity.verified ? true : undefined,
        );
        const deadlineAtMs = Date.now() + 30_000;
        await expect(
          service.recognize(Buffer.from('image'), { deadlineAtMs }),
        ).resolves.toMatchObject({ ok: false, reason });
        expect(service.getRuntimeStatus().behaviorIdentity.verified).toBe(true);
        expect(recognize).toHaveBeenCalledWith(expect.any(Buffer), 11, expect.any(Number), {
          deadlineAtMs,
        });
        await expect(service.recognize(Buffer.from('next image'))).resolves.toMatchObject({
          ok: true,
        });
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('keeps a local response watchdog expiration separate from safe queue rejection', async () => {
    const { service, sandbox, identity } = createIsolatedSandboxService();
    jest.spyOn(sandbox, 'probe').mockResolvedValue(verifiedNativeIdentity(identity));
    jest
      .spyOn(sandbox, 'recognize')
      .mockRejectedValueOnce(new NativeOcrSandboxRequestTimeoutError());
    try {
      service.onModuleInit();
      await waitFor(() =>
        service.getRuntimeStatus().behaviorIdentity.verified ? true : undefined,
      );
      await expect(service.recognize(Buffer.from('image'))).resolves.toMatchObject({
        ok: false,
        reason: 'request_timeout',
      });
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('counts rejected waiting requests in native queue observations', async () => {
    const { service, sandbox } = createIsolatedSandboxService();
    const metric = { last: 100, average: 50, maximum: 100, samples: 2 };
    const boundary = sandbox.getStatus();
    jest.spyOn(sandbox, 'getStatus').mockReturnValue({
      ...boundary,
      verified: true,
      runtimeStatusObservedAtMs: Date.now(),
      runtimeStatus: {
        activeOperation: 'idle',
        queueDepth: 0,
        pendingBytes: 0,
        remainingBudgetMs: null,
        queueWaitMs: metric,
        durationMs: { preprocess: metric, recognize: metric },
        counters: {
          started: 1,
          completed: 1,
          failed: 0,
          probes: 1,
          rejections: {
            capacity_exhausted: 0,
            request_deadline_exceeded: 1,
            shutting_down: 0,
            invalid_input: 0,
          },
        },
      },
    });
    try {
      expect(service.getRuntimeStatus().queueWaitMs).toMatchObject({ observed: 2, sampled: 2 });
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('reports missing sandbox queue diagnostics as unknown', async () => {
    const { service, sandbox, identity } = createIsolatedSandboxService();
    jest.spyOn(sandbox, 'probe').mockResolvedValue(verifiedNativeIdentity(identity));
    try {
      service.onModuleInit();
      await waitFor(() =>
        service.getRuntimeStatus().behaviorIdentity.verified ? true : undefined,
      );
      expect(service.getRuntimeStatus()).toMatchObject({
        queueDepth: null,
        workers: { busy: null },
        sandboxRuntime: { available: false, snapshot: null },
      });
      expect(service.getRuntimeStatus().queueWaitMs).toMatchObject({
        observed: null,
        sampled: null,
        last: null,
        average: null,
      });
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each(['unverified', 'invalid_response', 'unconfigured', 'unknown'] as const)(
    'blocks native work after a direct %s recognition failure until exact re-verification',
    async (reason) => {
      jest.useFakeTimers();
      const { service, sandbox, identity } = createIsolatedSandboxService();
      jest.spyOn(sandbox, 'probe').mockResolvedValue(verifiedNativeIdentity(identity));
      const recognize = jest
        .spyOn(sandbox, 'recognize')
        .mockRejectedValue(
          reason === 'unknown'
            ? new Error('unclassified recognition failure')
            : new NativeOcrSandboxUnavailableError(reason),
        );

      try {
        service.onModuleInit();
        await jest.advanceTimersByTimeAsync(0);
        await expect(service.recognize(Buffer.from('untrusted response'))).resolves.toMatchObject({
          ok: false,
          reason: 'artifact_unverified',
        });
        await expect(service.recognize(Buffer.from('blocked'))).resolves.toMatchObject({
          ok: false,
          reason: 'artifact_unverified',
        });
        expect(recognize).toHaveBeenCalledTimes(1);
        expect(service.workers).toHaveLength(0);

        recognize.mockResolvedValue(emptySandboxRecognition());
        await jest.advanceTimersByTimeAsync(5_000);
        await expect(service.recognize(Buffer.from('freshly verified'))).resolves.toMatchObject({
          ok: true,
        });
        expect(recognize).toHaveBeenCalledTimes(2);
      } finally {
        await service.onModuleDestroy();
        jest.useRealTimers();
      }
    },
  );

  it.each([
    { nodeEnv: 'production', expectedReason: 'worker_unavailable' },
    { nodeEnv: 'test', expectedReason: 'artifact_unverified' },
  ])(
    'classifies direct transport loss under $nodeEnv without further native work',
    async ({ nodeEnv, expectedReason }) => {
      jest.useFakeTimers();
      const { service, sandbox, identity } = createIsolatedSandboxService({ NODE_ENV: nodeEnv });
      jest.spyOn(sandbox, 'probe').mockResolvedValue(verifiedNativeIdentity(identity));
      const recognize = jest
        .spyOn(sandbox, 'recognize')
        .mockRejectedValue(new NativeOcrSandboxUnavailableError('unavailable'));

      try {
        service.onModuleInit();
        await jest.advanceTimersByTimeAsync(0);
        await expect(service.recognize(Buffer.from('transport loss'))).resolves.toMatchObject({
          ok: false,
          reason: expectedReason,
        });
        await expect(
          service.recognize(Buffer.from('blocked pending probe')),
        ).resolves.toMatchObject({
          ok: false,
          reason: expectedReason,
        });
        expect(recognize).toHaveBeenCalledTimes(1);
        expect(service.workers).toHaveLength(0);
      } finally {
        await service.onModuleDestroy();
        jest.useRealTimers();
      }
    },
  );

  it('rejects verified artifacts whose runtime controls drift from production', async () => {
    const config = new ConfigService({
      APP_SERVICE_NAME: 'api-media-analysis',
      COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: 16 * 1024 * 1024,
    });
    const expectedIdentity = completeNativeIdentity(config);
    const driftedIdentity = completeNativeIdentity(
      new ConfigService({
        APP_SERVICE_NAME: 'api-media-analysis',
        COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: 2 * 1024 * 1024,
      }),
    );
    const service = new VerificationGatedNativeTesseractOcrAdapter(
      config,
      async () => verifiedNativeIdentity(driftedIdentity),
      expectedIdentity,
    );
    services.push(service);

    service.onModuleInit();
    await waitFor(() =>
      service.getRuntimeStatus().behaviorIdentity.state === 'failed' ? true : undefined,
    );

    expect(service.workers).toHaveLength(0);
    expect(service.getRuntimeStatus()).toMatchObject({
      state: 'degraded',
      ready: false,
      workers: { live: 0, ready: 0, busy: 0 },
      behaviorIdentity: {
        state: 'failed',
        verified: false,
        mismatchFields: ['controls.productionProfile'],
      },
    });
  });

  it('rejects an expired absolute deadline before initializing a worker', async () => {
    const service = createService();
    services.push(service);

    await expect(
      service.recognize(Buffer.from('private pixels'), { deadlineAtMs: Date.now() }),
    ).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(service.workers).toHaveLength(0);
    expect(service.getRuntimeStatus()).toMatchObject({
      state: 'starting',
      ready: false,
      workers: { live: 0, ready: 0, busy: 0 },
      queueDepth: 0,
      counters: { completed: 0, failed: 1, failuresByReason: { timeout: 1 } },
      latencyMs: {
        last: expect.any(Number),
        average: expect.any(Number),
        maximum: expect.any(Number),
      },
    });
  });

  it('bounds the worker request timeout by the caller absolute deadline', async () => {
    const service = createService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000 });
    services.push(service);
    const recognition = service.recognize(Buffer.from('image'), {
      deadlineAtMs: Date.now() + 2_000,
    });
    const worker = await readyWorker(service, 0);
    const request = await recognizeRequest(worker);

    expect(request.timeoutMs).toBeGreaterThan(0);
    expect(request.timeoutMs).toBeLessThanOrEqual(1_500);
    worker.respond(request.jobId);
    await expect(recognition).resolves.toMatchObject({ ok: true });
  });

  it('reserves watchdog grace inside a caller absolute deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
    const performanceNow = jest.spyOn(performance, 'now').mockReturnValue(0);
    const service = new TestNativeTesseractOcrAdapter(
      new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 10_000 }),
    );
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const worker = service.workers[0]!;
      const recognition = service.recognize(Buffer.from('image'), {
        deadlineAtMs: Date.now() + 9_000,
      });
      const request = worker.requests.find((candidate) => candidate.type === 'recognize');
      if (!request || request.type !== 'recognize') {
        throw new Error('Expected a recognize request');
      }
      expect(request.timeoutMs).toBe(8_500);

      await jest.advanceTimersByTimeAsync(8_500);
      worker.fail(request.jobId, 'timeout');

      await expect(recognition).resolves.toMatchObject({ ok: false, reason: 'timeout' });
      expect(worker.killSignals).toEqual([]);
      expect(service.getRuntimeStatus().counters).toMatchObject({ restarts: 0 });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('does not start native work without enough caller budget for watchdog grace', async () => {
    const service = createService();
    services.push(service);

    await expect(
      service.recognize(Buffer.from('private pixels'), {
        deadlineAtMs: Date.now() + 500,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(service.workers).toHaveLength(0);
  });

  it('enters cooldown after repeated workers miss the startup watchdog', async () => {
    jest.useFakeTimers();
    let monotonicNowMs = 0;
    const performanceNow = jest.spyOn(performance, 'now').mockImplementation(() => monotonicNowMs);
    const service = new TestNativeTesseractOcrAdapter(
      new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000 }),
      false,
    );
    try {
      service.onModuleInit();
      expect(service.workers).toHaveLength(1);

      for (let failure = 0; failure < 4; failure += 1) {
        monotonicNowMs += 5_000;
        await jest.advanceTimersByTimeAsync(5_000);
        if (failure < 3) {
          monotonicNowMs += 100;
          await jest.advanceTimersByTimeAsync(100);
        }
      }

      expect(service.workers).toHaveLength(4);
      expect(service.workers.every((worker) => worker.killSignals.includes('SIGTERM'))).toBe(true);
      expect(service.getRuntimeStatus()).toMatchObject({
        state: 'degraded',
        ready: false,
        workers: { live: 0, ready: 0, busy: 0 },
        counters: { restarts: 3 },
      });

      monotonicNowMs += 29_999;
      await jest.advanceTimersByTimeAsync(29_999);
      expect(service.workers).toHaveLength(4);
      await expect(service.recognize(Buffer.from('during cooldown'))).resolves.toMatchObject({
        ok: false,
        reason: 'worker_unavailable',
      });
      expect(service.getRuntimeStatus().counters).toMatchObject({
        completed: 0,
        failed: 1,
        failuresByReason: { worker_unavailable: 1 },
      });

      monotonicNowMs += 1;
      await jest.advanceTimersByTimeAsync(1);
      const recovery = service.recognize(Buffer.from('after cooldown'));
      expect(service.workers).toHaveLength(5);
      const recoveredWorker = service.workers[4]!;
      recoveredWorker.emit('message', {
        type: 'ready',
      } satisfies NativeTesseractWorkerResponse);
      const request = await recognizeRequest(recoveredWorker);
      recoveredWorker.respond(request.jobId);
      await expect(recovery).resolves.toMatchObject({ ok: true });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('applies the same restart budget to repeated protocol failures after ready', async () => {
    jest.useFakeTimers();
    let monotonicNowMs = 0;
    const performanceNow = jest.spyOn(performance, 'now').mockImplementation(() => monotonicNowMs);
    const service = new TestNativeTesseractOcrAdapter(
      new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000 }),
    );
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);

      for (let failure = 0; failure < 4; failure += 1) {
        const worker = service.workers[failure]!;
        worker.emit('message', { type: 'unexpected' });
        await jest.advanceTimersByTimeAsync(0);
        if (failure < 3) {
          monotonicNowMs += 100;
          await jest.advanceTimersByTimeAsync(100);
        }
      }

      expect(service.workers).toHaveLength(4);
      expect(service.getRuntimeStatus()).toMatchObject({
        state: 'degraded',
        ready: false,
        workers: { live: 0, ready: 0, busy: 0 },
        counters: { restarts: 3 },
      });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(service.workers).toHaveLength(4);
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('uses a ten-second native budget and keeps the worker alive for a native timeout', async () => {
    jest.useFakeTimers();
    const performanceNow = jest.spyOn(performance, 'now').mockReturnValue(0);
    const service = new TestNativeTesseractOcrAdapter(new ConfigService({}));
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const worker = service.workers[0]!;
      const recognition = service.recognize(Buffer.from('image'));
      const request = worker.requests.find((candidate) => candidate.type === 'recognize');
      if (!request || request.type !== 'recognize') {
        throw new Error('Expected a recognize request');
      }
      expect(request.timeoutMs).toBe(10_000);

      let settled = false;
      void recognition.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false);

      worker.fail(request.jobId, 'timeout');
      await expect(recognition).resolves.toMatchObject({ ok: false, reason: 'timeout' });
      expect(service.workers).toHaveLength(1);
      expect(worker.killSignals).toEqual([]);
      expect(service.getRuntimeStatus()).toMatchObject({
        ready: true,
        counters: {
          failed: 1,
          restarts: 0,
          failuresByReason: { timeout: 1 },
        },
      });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('recycles and reports an unavailable worker that misses the result watchdog grace', async () => {
    jest.useFakeTimers();
    const performanceNow = jest.spyOn(performance, 'now').mockReturnValue(0);
    const service = new TestNativeTesseractOcrAdapter(
      new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 250 }),
    );
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const worker = service.workers[0]!;
      const recognition = service.recognize(Buffer.from('image'));
      expect(worker.requests).toContainEqual(expect.objectContaining({ timeoutMs: 250 }));

      let settled = false;
      void recognition.then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(749);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      await expect(recognition).resolves.toMatchObject({
        ok: false,
        reason: 'worker_unavailable',
      });
      await jest.advanceTimersByTimeAsync(100);
      expect(service.workers).toHaveLength(2);
      expect(worker.killSignals).toContain('SIGTERM');
      expect(service.getRuntimeStatus().counters).toMatchObject({
        failed: 1,
        restarts: 1,
        failuresByReason: { worker_unavailable: 1 },
      });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('keeps an explicit worker send failure retryable', async () => {
    const service = createService();
    services.push(service);
    service.onModuleInit();
    const worker = await readyWorker(service, 0);
    worker.sendError = new Error('IPC send failed');

    const recognition = service.recognize(Buffer.from('image'));

    await expect(recognition).resolves.toMatchObject({
      ok: false,
      reason: 'worker_unavailable',
    });
    await expect(readyWorker(service, 1)).resolves.not.toBe(worker);
    expect(service.getRuntimeStatus().counters).toMatchObject({
      failed: 1,
      restarts: 1,
      failuresByReason: { worker_unavailable: 1 },
    });
  });

  it('dispatches queued work only after a retiring worker is replaced', async () => {
    const service = createService();
    services.push(service);
    const first = service.recognize(Buffer.from('first'));
    const firstWorker = await readyWorker(service, 0);
    const firstRequest = await recognizeRequest(firstWorker);
    const second = service.recognize(Buffer.from('second'));

    firstWorker.fail(firstRequest.jobId, 'timeout', true);

    await expect(first).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(firstWorker.requests.filter((request) => request.type === 'recognize')).toHaveLength(1);
    const secondWorker = await readyWorker(service, 1);
    expect(secondWorker).not.toBe(firstWorker);
    const secondRequest = await recognizeRequest(secondWorker);
    secondWorker.respond(secondRequest.jobId, 'Второй');
    await expect(second).resolves.toMatchObject({ ok: true, text: 'Второй' });
  });

  it('fails work whose native budget expires in the adapter queue as capacity pressure', async () => {
    jest.useFakeTimers();
    let monotonicNowMs = 0;
    const performanceNow = jest.spyOn(performance, 'now').mockImplementation(() => monotonicNowMs);
    const service = new TestNativeTesseractOcrAdapter(
      new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 250 }),
    );
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const worker = service.workers[0]!;
      const first = service.recognize(Buffer.from('first'));
      const firstRequest = worker.requests.find((candidate) => candidate.type === 'recognize');
      if (!firstRequest || firstRequest.type !== 'recognize') {
        throw new Error('Expected the first recognize request');
      }
      const queued = service.recognize(Buffer.from('queued'));

      monotonicNowMs = 251;
      worker.respond(firstRequest.jobId);

      await expect(first).resolves.toMatchObject({ ok: true });
      await expect(queued).resolves.toMatchObject({
        ok: false,
        reason: 'capacity_exhausted',
      });
      expect(service.workers).toHaveLength(1);
      expect(worker.killSignals).toEqual([]);
      expect(service.getRuntimeStatus().counters).toMatchObject({
        completed: 1,
        failed: 1,
        restarts: 0,
        failuresByReason: { capacity_exhausted: 1 },
      });
    } finally {
      performanceNow.mockRestore();
      jest.useRealTimers();
      await service.onModuleDestroy();
    }
  });

  it('bounds active work and its waiting queue', async () => {
    const service = createService({
      COMMERCIAL_OCR_TESSERACT_CONCURRENCY: 1,
      COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: 1,
    });
    services.push(service);
    const first = service.recognize(Buffer.from('first'));
    const worker = await readyWorker(service, 0);
    const firstRequest = await recognizeRequest(worker);
    const second = service.recognize(Buffer.from('second'));

    await expect(service.recognize(Buffer.from('third'))).resolves.toMatchObject({
      ok: false,
      status: 'failed_open',
      reason: 'capacity_exhausted',
    });

    worker.respond(firstRequest.jobId, 'Первый');
    await expect(first).resolves.toMatchObject({ ok: true, text: 'Первый' });
    const secondRequest = await recognizeRequest(worker, 1);
    worker.respond(secondRequest.jobId, 'Второй');
    await expect(second).resolves.toMatchObject({ ok: true, text: 'Второй' });
    expect(service.getRuntimeStatus().queueWaitMs).toMatchObject({
      observed: 2,
      sampled: 2,
      capacity: 512,
      last: expect.any(Number),
      p95: expect.any(Number),
      p99: expect.any(Number),
    });
    expect(service.getRuntimeStatus().counters).toMatchObject({
      completed: 2,
      failed: 1,
      failuresByReason: { capacity_exhausted: 1 },
    });
  });

  it('recycles a host worker after the configured number of jobs', async () => {
    const service = createService({ COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: 1 });
    services.push(service);
    const first = service.recognize(Buffer.from('first'));
    const firstWorker = await readyWorker(service, 0);
    const firstRequest = await recognizeRequest(firstWorker);
    firstWorker.respond(firstRequest.jobId);
    await expect(first).resolves.toMatchObject({ ok: true });

    const secondWorker = await readyWorker(service, 1);
    expect(secondWorker).not.toBe(firstWorker);
    expect(service.getRuntimeStatus().counters).toMatchObject({
      completed: 1,
      failed: 0,
      restarts: 1,
      recycles: 1,
    });
    const second = service.recognize(Buffer.from('second'));
    const secondRequest = await recognizeRequest(secondWorker);
    secondWorker.respond(secondRequest.jobId);
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('fails open and recycles a worker that returns an unknown failure reason', async () => {
    const service = createService();
    services.push(service);
    const recognition = service.recognize(Buffer.from('image'));
    const worker = await readyWorker(service, 0);
    const request = await recognizeRequest(worker);

    worker.emit('message', {
      type: 'result',
      jobId: request.jobId,
      result: { ok: false, reason: 'capacity_exhausted' },
    });

    await expect(recognition).resolves.toMatchObject({
      ok: false,
      status: 'failed_open',
      reason: 'invalid_output',
    });
    await expect(readyWorker(service, 1)).resolves.not.toBe(worker);
    expect(service.getRuntimeStatus().counters).toMatchObject({
      completed: 0,
      failed: 1,
      restarts: 1,
      failuresByReason: { invalid_output: 1 },
    });
  });

  it('exposes only aggregate privacy-safe runtime status', async () => {
    const service = createService();
    services.push(service);
    const privateImage = Buffer.from('private-image-pixels');
    const recognition = service.recognize(privateImage, { passLabel: 'private-pass' });
    const worker = await readyWorker(service, 0);
    const request = await recognizeRequest(worker);
    worker.respond(request.jobId, 'СЕКРЕТНЫЙ OCR ТЕКСТ');
    await expect(recognition).resolves.toMatchObject({ ok: true });

    const status = service.getRuntimeStatus();
    expect(status).toMatchObject({
      state: 'ready',
      ready: true,
      workers: { configured: 1, live: 1, ready: 1, busy: 0 },
      queueDepth: 0,
      counters: { completed: 1, failed: 0 },
      queueWaitMs: {
        observed: 1,
        sampled: 1,
        capacity: 512,
      },
    });
    const serialized = JSON.stringify(status);
    for (const privateValue of [
      'СЕКРЕТНЫЙ OCR ТЕКСТ',
      privateImage.toString('base64'),
      request.jobId,
      'private-pass',
      'https://',
      'image',
      'text',
      'jobId',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('fails queued and active work open during shutdown', async () => {
    const service = createService();
    const active = service.recognize(Buffer.from('active'));
    await readyWorker(service, 0);
    const queued = service.recognize(Buffer.from('queued'));
    await service.onModuleDestroy();

    await expect(active).resolves.toMatchObject({ ok: false, reason: 'shutting_down' });
    await expect(queued).resolves.toMatchObject({ ok: false, reason: 'shutting_down' });
    await expect(service.recognize(Buffer.from('late'))).resolves.toMatchObject({
      ok: false,
      reason: 'shutting_down',
    });
    expect(service.getRuntimeStatus().counters).toMatchObject({
      completed: 0,
      failed: 3,
      failuresByReason: { shutting_down: 3 },
    });
  });

  it('quarantines late errors until a stubborn worker exits after shutdown', async () => {
    jest.useFakeTimers();
    try {
      const service = new TestStubbornNativeTesseractOcrAdapter(
        new ConfigService({ COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000 }),
      );
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(service.getRuntimeStatus().ready).toBe(true);

      const shutdown = service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(1_249);
      expect(service.worker.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
      await jest.advanceTimersByTimeAsync(1);
      await expect(shutdown).resolves.toBeUndefined();

      expect(service.getRuntimeStatus()).toMatchObject({
        state: 'shutting_down',
        ready: false,
        workers: { live: 0, ready: 0, busy: 0 },
      });
      expect(service.worker.listenerCount('message')).toBe(0);
      expect(service.worker.listenerCount('error')).toBe(1);
      expect(service.worker.listenerCount('exit')).toBe(1);

      expect(() => service.worker.emit('error', new Error('late child error'))).not.toThrow();
      service.worker.exitCode = 1;
      service.worker.emit('exit', 1, null);

      expect(service.worker.listenerCount('error')).toBe(0);
      expect(service.worker.listenerCount('exit')).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

function createService(config: Record<string, unknown> = {}): TestNativeTesseractOcrAdapter {
  return new TestNativeTesseractOcrAdapter(
    new ConfigService({
      COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 2_000,
      ...config,
    }),
  );
}

function createIsolatedSandboxService(overrides: Record<string, unknown> = {}) {
  const config = new ConfigService({
    NODE_ENV: 'production',
    APP_SERVICE_NAME: 'api-media-analysis',
    COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/native-ocr.sock',
    ...overrides,
  });
  const identity = completeNativeIdentity(config);
  const service = new TestNativeTesseractOcrAdapter(config);
  Object.defineProperty(service, 'nativeBehaviorIdentity', { configurable: true, value: identity });
  const sandbox = Reflect.get(service, 'sandbox') as NativeOcrSandboxPool;
  return { service, sandbox, identity };
}

function emptySandboxRecognition() {
  return {
    ok: true as const,
    payload: {
      text: '',
      aggregateConfidence: null,
      words: [],
      lines: [],
      truncated: false,
    },
  };
}

function completeNativeIdentity(config: ConfigService): CommercialOcrNativeBehaviorIdentity {
  return createCommercialOcrNativeBehaviorIdentity({
    controls: resolveCommercialOcrNativeRuntimeControls(
      resolveCommercialOcrProductionNativeConfigReader(config),
    ),
    buildManifestSha256: '8'.repeat(64),
    artifacts: {
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        sharpVersion: '0.35.3',
        libvipsVersion: '8.18.3',
      },
      tesseract: {
        version: 'tesseract 5.5.2',
        binarySha256: '7'.repeat(64),
        availableLanguages: ['eng', 'rus'],
        traineddataSha256: { rus: '6'.repeat(64), eng: '5'.repeat(64) },
      },
    },
  });
}

function verifiedNativeIdentity(
  identity: CommercialOcrNativeBehaviorIdentity,
): CommercialOcrNativeArtifactVerification {
  return { verified: true, status: 'verified', mismatches: [], identity };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function readyWorker(
  service: TestNativeTesseractOcrAdapter,
  index: number,
): Promise<FakeWorker> {
  await waitFor(() => service.workers[index]);
  const worker = service.workers[index];
  await new Promise((resolve) => setImmediate(resolve));
  return worker;
}

async function recognizeRequest(worker: FakeWorker, index = 0) {
  await waitFor(() => worker.requests.filter((request) => request.type === 'recognize')[index]);
  const request = worker.requests.filter((candidate) => candidate.type === 'recognize')[index];
  if (request.type !== 'recognize') {
    throw new Error('Expected a recognize request');
  }
  return request;
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for test state');
}
