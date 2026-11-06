import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

import { NativeOcrSandboxClient } from './native-ocr-sandbox.client';
import * as nativeOcrSandboxClock from './native-ocr-sandbox.clock';
import {
  assertNativeOcrSandboxNetworkIsolated,
  startNativeOcrSandboxServer,
  type NativeOcrSandboxServerDependencies,
} from './native-ocr-sandbox.server';
import {
  decodeNativeOcrSandboxFrame,
  encodeNativeOcrSandboxFrame,
  NATIVE_OCR_SANDBOX_FRAME_KINDS,
} from './native-ocr-sandbox.protocol';
import { parseNativeOcrSandboxRuntimeStatus } from './native-ocr-sandbox.runtime';

describe('native OCR sandbox server containment', () => {
  it('rejects an unverified monotonic clock before loading native dependencies', async () => {
    const verifyNativeIdentity = jest.fn();
    const createPreprocessor = jest.fn();
    const probeNativeTesseract = jest.fn();
    const clock = jest
      .spyOn(nativeOcrSandboxClock, 'assertNativeOcrSandboxSharedClock')
      .mockImplementation(() => {
        throw new Error('Unverified shared clock');
      });
    try {
      await expect(
        startNativeOcrSandboxServer(sandboxEnvironment('/tmp/never-created-ocr.sock'), {
          ...successfulServerDependencies(),
          verifyNativeIdentity,
          createPreprocessor,
          probeNativeTesseract,
        }),
      ).rejects.toThrow('Unverified shared clock');
      expect(verifyNativeIdentity).not.toHaveBeenCalled();
      expect(createPreprocessor).not.toHaveBeenCalled();
      expect(probeNativeTesseract).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('serves preprocessing and recognition over the same bounded Unix protocol', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-roundtrip-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    const preprocess = jest.fn(async () => ({
      bytes: Buffer.from('prepared'),
      width: 10,
      height: 5,
    }));
    const recognize = jest.fn(async () => ({
      ok: true as const,
      payload: {
        text: 'TEST',
        aggregateConfidence: 95,
        words: [
          {
            text: 'TEST',
            start: 0,
            end: 4,
            confidence: 95,
            lineIndex: 0,
            boundingBox: { left: 0, top: 0, width: 10, height: 5 },
          },
        ],
        lines: [
          {
            text: 'TEST',
            start: 0,
            end: 4,
            confidence: 95,
            wordStartIndex: 0,
            wordEndIndex: 1,
            boundingBox: { left: 0, top: 0, width: 10, height: 5 },
          },
        ],
        truncated: false,
      },
    }));
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      createPreprocessor: async () => ({ prepare: preprocess }),
      runNativeTesseract: recognize as NativeOcrSandboxServerDependencies['runNativeTesseract'],
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      const prepared = await client.preprocess(Buffer.from('source'), 'primary', 2_000);
      expect(prepared).toEqual({ bytes: Buffer.from('prepared'), width: 10, height: 5 });
      await expect(client.recognize(prepared.bytes, 6, 1_000)).resolves.toMatchObject({
        ok: true,
        payload: { text: 'TEST', aggregateConfidence: 95 },
      });
      expect(preprocess).toHaveBeenCalledTimes(1);
      expect(recognize).toHaveBeenCalledTimes(1);
      expect(client.isVerified()).toBe(true);
    } finally {
      client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('terminates and verifies an active native process group before shutdown completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-server-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    let resolveNative!: (result: { ok: false; reason: 'timeout' }) => void;
    let markNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      markNativeStarted = resolve;
    });
    const nativeResult = new Promise<{ ok: false; reason: 'timeout' }>((resolve) => {
      resolveNative = resolve;
    });
    const child = { pid: 432, kill: jest.fn() } as unknown as ChildProcessWithoutNullStreams;
    const signalGroup = jest.fn(() => {
      resolveNative({ ok: false, reason: 'timeout' });
      return true;
    });
    const verifyGroup = jest.fn(async () => true);
    const fatalExit = jest.fn();
    const dependencies: Partial<NativeOcrSandboxServerDependencies> = {
      allowTestSocketPath: true,
      networkInterfaces: (() => ({
        lo: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
      })) as NativeOcrSandboxServerDependencies['networkInterfaces'],
      verifyNativeIdentity: async (_config, expected) => ({
        verified: true,
        status: 'verified',
        mismatches: [],
        identity: { ...expected, complete: true },
      }),
      probeNativeTesseract: jest.fn(
        async () => ({ ok: true }) as const,
      ) as NativeOcrSandboxServerDependencies['probeNativeTesseract'],
      runNativeTesseract: jest.fn(async (options) => {
        options.onProcessChange?.(child);
        markNativeStarted();
        return nativeResult;
      }) as NativeOcrSandboxServerDependencies['runNativeTesseract'],
      createPreprocessor: async () => ({
        prepare: async () => ({ bytes: Buffer.from('prepared'), width: 1, height: 1 }),
      }),
      signalNativeProcessGroup: signalGroup,
      verifyNativeProcessGroupTeardown: verifyGroup,
      fatalExit,
    };

    const server = await startNativeOcrSandboxServer(environment, dependencies);
    const client = new NativeOcrSandboxClient(testClientConfig(environment));
    try {
      const recognition = client.recognize(Buffer.from('prepared'), 6, 5_000);
      const recognitionOutcome = expect(recognition).rejects.toMatchObject({
        reason: expect.stringMatching(/^(?:unavailable|invalid_response)$/u),
      });
      await nativeStarted;
      await server.close();
      await recognitionOutcome;
      expect(signalGroup).toHaveBeenCalledWith(child, 'SIGKILL', {
        requireIsolatedGroup: true,
      });
      expect(verifyGroup).toHaveBeenCalledWith(child, {
        graceMs: 500,
        requireIsolatedGroup: true,
      });
      expect(fatalExit).not.toHaveBeenCalled();
    } finally {
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('observes a client deadline disconnect and cancels active native work', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-cancel-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    let markNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      markNativeStarted = resolve;
    });
    let resolveNative!: (result: { ok: false; reason: 'tesseract_failed' }) => void;
    const nativeResult = new Promise<{ ok: false; reason: 'tesseract_failed' }>((resolve) => {
      resolveNative = resolve;
    });
    const child = { pid: 433, kill: jest.fn() } as unknown as ChildProcessWithoutNullStreams;
    const signalGroup = jest.fn(() => {
      resolveNative({ ok: false, reason: 'tesseract_failed' });
      return true;
    });
    const fatalExit = jest.fn();
    const previousExitCode = process.exitCode;
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      runNativeTesseract: jest.fn(async (options) => {
        options.onProcessChange?.(child);
        markNativeStarted();
        return nativeResult;
      }) as NativeOcrSandboxServerDependencies['runNativeTesseract'],
      signalNativeProcessGroup: signalGroup,
      verifyNativeProcessGroupTeardown: jest.fn(async () => true),
      fatalExit,
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      const recognition = client.recognize(Buffer.from('prepared'), 6, 150);
      const outcome = expect(recognition).rejects.toMatchObject({
        name: 'NativeOcrSandboxRequestTimeoutError',
      });
      await nativeStarted;
      await outcome;
      await waitFor(() => signalGroup.mock.calls.length > 0);
      expect(signalGroup).toHaveBeenCalledWith(child, 'SIGKILL', {
        requireIsolatedGroup: true,
      });
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['primary', 'confirmation'] as const)(
    'attributes %s preprocessing when its client disconnects',
    async (pass) => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-preprocess-cancel-'));
      const socketPath = join(directory, 'ocr.sock');
      const environment = sandboxEnvironment(socketPath);
      let markPreprocessStarted!: () => void;
      const preprocessStarted = new Promise<void>((resolve) => {
        markPreprocessStarted = resolve;
      });
      let resolvePreprocess!: (result: { bytes: Buffer; width: number; height: number }) => void;
      const preprocessResult = new Promise<{ bytes: Buffer; width: number; height: number }>(
        (resolve) => {
          resolvePreprocess = resolve;
        },
      );
      const fatalExit = jest.fn();
      const recordLifecycleEvent = jest.fn<
        ReturnType<NativeOcrSandboxServerDependencies['recordLifecycleEvent']>,
        Parameters<NativeOcrSandboxServerDependencies['recordLifecycleEvent']>
      >();
      const previousExitCode = process.exitCode;
      const server = await startNativeOcrSandboxServer(environment, {
        ...successfulServerDependencies(),
        createPreprocessor: async () => ({
          prepare: async () => {
            markPreprocessStarted();
            return preprocessResult;
          },
        }),
        fatalExit,
        recordLifecycleEvent,
      });
      const client = new NativeOcrSandboxClient(testClientConfig(environment));

      try {
        const input = Buffer.from('private-preprocess-source');
        const preprocessing = client.preprocess(input, pass, 5_000);
        const outcome = expect(preprocessing).rejects.toMatchObject({ reason: 'unavailable' });
        await preprocessStarted;
        client.close();
        await outcome;
        await waitFor(() => fatalExit.mock.calls.length > 0);
        expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
        expect(recordLifecycleEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'active_client_cancel',
            operation: 'preprocess',
            preprocessPass: pass,
            psm: 'unavailable',
            payloadBytes: input.byteLength,
          }),
        );
        expect(JSON.stringify(recordLifecycleEvent.mock.calls[0]![0])).not.toContain(
          'private-preprocess-source',
        );
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
        resolvePreprocess({ bytes: Buffer.from('prepared'), width: 1, height: 1 });
        client.close();
        await server.close().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('kills and recycles a native process that starts after its client socket closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-late-native-cancel-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    let markRecognitionEntered!: () => void;
    const recognitionEntered = new Promise<void>((resolve) => {
      markRecognitionEntered = resolve;
    });
    let releaseNativeStart!: () => void;
    const nativeStartReleased = new Promise<void>((resolve) => {
      releaseNativeStart = resolve;
    });
    let resolveNative!: (result: { ok: false; reason: 'tesseract_failed' }) => void;
    const nativeResult = new Promise<{ ok: false; reason: 'tesseract_failed' }>((resolve) => {
      resolveNative = resolve;
    });
    const child = { pid: 434, kill: jest.fn() } as unknown as ChildProcessWithoutNullStreams;
    const signalGroup = jest.fn(() => {
      resolveNative({ ok: false, reason: 'tesseract_failed' });
      return true;
    });
    const fatalExit = jest.fn();
    const recordLifecycleEvent = jest.fn<
      ReturnType<NativeOcrSandboxServerDependencies['recordLifecycleEvent']>,
      Parameters<NativeOcrSandboxServerDependencies['recordLifecycleEvent']>
    >();
    const previousExitCode = process.exitCode;
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      runNativeTesseract: jest.fn(async (options) => {
        markRecognitionEntered();
        await nativeStartReleased;
        options.onProcessChange?.(child);
        return nativeResult;
      }) as NativeOcrSandboxServerDependencies['runNativeTesseract'],
      signalNativeProcessGroup: signalGroup,
      fatalExit,
      recordLifecycleEvent,
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      const recognition = client.recognize(Buffer.from('prepared'), 6, 5_000);
      const outcome = expect(recognition).rejects.toMatchObject({ reason: 'unavailable' });
      await recognitionEntered;
      client.close();
      await outcome;
      releaseNativeStart();
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
      expect(recordLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'active_client_cancel',
          operation: 'recognize',
          psm: 6,
          preprocessPass: 'unavailable',
          payloadBytes: Buffer.byteLength('prepared'),
        }),
      );
      expect(signalGroup).toHaveBeenCalledWith(child, 'SIGKILL', {
        requireIsolatedGroup: true,
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      releaseNativeStart();
      resolveNative({ ok: false, reason: 'tesseract_failed' });
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recycles the whole sandbox after a forced native timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-recycle-'));
    const socketPath = join(directory, 'ocr.sock');
    const environment = sandboxEnvironment(socketPath);
    const fatalExit = jest.fn();
    const previousExitCode = process.exitCode;
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      runNativeTesseract: jest.fn(async () => ({ ok: false, reason: 'timeout' }) as const),
      fatalExit,
    });
    const client = new NativeOcrSandboxClient(testClientConfig(environment));

    try {
      await client.recognize(Buffer.from('prepared'), 6, 1_000).catch(() => undefined);
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      client.close();
      await server.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([6, 11] as const)(
    'attributes PSM%s without reusing completed preprocessing metadata or delaying recycle',
    async (psm) => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-stalled-diagnostic-'));
      const environment = sandboxEnvironment(join(directory, 'ocr.sock'));
      const fatalExit = jest.fn();
      const recordLifecycleEvent = jest.fn<
        ReturnType<NativeOcrSandboxServerDependencies['recordLifecycleEvent']>,
        Parameters<NativeOcrSandboxServerDependencies['recordLifecycleEvent']>
      >(() => new Promise<void>(() => {}));
      const runNativeTesseract = jest.fn<
        ReturnType<NativeOcrSandboxServerDependencies['runNativeTesseract']>,
        Parameters<NativeOcrSandboxServerDependencies['runNativeTesseract']>
      >(async () => ({ ok: false, reason: 'timeout' }));
      const previousExitCode = process.exitCode;
      const server = await startNativeOcrSandboxServer(environment, {
        ...successfulServerDependencies(),
        runNativeTesseract,
        createPreprocessor: async () => ({
          prepare: async () => ({ bytes: Buffer.from('prepared'), width: 1, height: 1 }),
        }),
        fatalExit,
        recordLifecycleEvent,
      });
      const client = new NativeOcrSandboxClient(testClientConfig(environment));

      try {
        await expect(
          client.preprocess(Buffer.from('completed-source'), 'confirmation', 5_000),
        ).resolves.toMatchObject({ width: 1, height: 1 });
        expect(recordLifecycleEvent).not.toHaveBeenCalled();
        await client
          .recognize(Buffer.from('private-prepared-image'), psm, 1_000)
          .catch(() => undefined);
        await server.close();
        await waitFor(() => fatalExit.mock.calls.length > 0);
        expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
        expect(recordLifecycleEvent).toHaveBeenCalledWith({
          event: 'native_ocr_sandbox_recycle',
          reason: 'native_timeout',
          operation: 'recognize',
          psm,
          preprocessPass: 'unavailable',
          payloadBytes: 22,
          queueDepth: 0,
          pendingBytes: 0,
          requestedTimeoutMs: 1_000,
          executionBudgetMs: expect.any(Number),
          queueWaitMs: expect.any(Number),
          operationElapsedMs: expect.any(Number),
        });
        const diagnostic = recordLifecycleEvent.mock.calls[0]![0];
        expect(diagnostic.executionBudgetMs).toBeGreaterThan(0);
        expect(diagnostic.executionBudgetMs).toBeLessThanOrEqual(1_000);
        expect(diagnostic.executionBudgetMs).toBe(runNativeTesseract.mock.calls[0]![0].timeoutMs);
        expect(diagnostic.queueWaitMs).toBeGreaterThanOrEqual(0);
        expect(diagnostic.operationElapsedMs).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(diagnostic)).not.toContain('private-prepared-image');
        expect(runNativeTesseract).toHaveBeenCalledTimes(1);
        expect(fatalExit).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
        client.close();
        await server.close().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('rejects any non-loopback interface before binding the socket', () => {
    expect(() =>
      assertNativeOcrSandboxNetworkIsolated({
        eth0: [
          {
            address: '10.0.0.2',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '10.0.0.2/24',
          },
        ],
      }),
    ).toThrow('non-loopback');
  });

  it('expires a queued request without starting native or recycling the active request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-queued-expiry-'));
    const environment = sandboxEnvironment(join(directory, 'ocr.sock'));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishFirst!: (result: ReturnType<typeof emptyRecognition>) => void;
    const firstResult = new Promise<ReturnType<typeof emptyRecognition>>((resolve) => {
      finishFirst = resolve;
    });
    const runNative = jest.fn(async () => {
      markStarted();
      return firstResult;
    });
    const fatalExit = jest.fn();
    const signalGroup = jest.fn(() => true);
    const lifecycle = jest.fn();
    const server = await startNativeOcrSandboxServer(environment, {
      ...successfulServerDependencies(),
      runNativeTesseract: runNative,
      signalNativeProcessGroup: signalGroup,
      fatalExit,
      recordLifecycleEvent: lifecycle,
    });
    const firstClient = new NativeOcrSandboxClient(testClientConfig(environment));
    const waitingClient = new NativeOcrSandboxClient(testClientConfig(environment));
    try {
      const first = firstClient.recognize(Buffer.from('prepared'), 6, 3_000);
      await started;
      const waiting = waitingClient.recognize(Buffer.from('prepared'), 6, 300);
      const rejected = expect(waiting).rejects.toMatchObject({
        reason: 'request_deadline_exceeded',
      });
      const during = await waitForQueuedRuntime(server.socketPath);
      expect(during).toMatchObject({
        activeOperation: 'recognize',
        queueDepth: 1,
        counters: { started: 1 },
      });
      await rejected;
      expect(waitingClient.isVerified()).toBe(true);
      expect(waitingClient.getStatus().runtimeStatus).toMatchObject({
        queueDepth: 0,
        counters: { started: 1, rejections: { request_deadline_exceeded: 1 } },
      });
      finishFirst(emptyRecognition());
      await expect(first).resolves.toMatchObject({ ok: true });
      expect(runNative).toHaveBeenCalledTimes(1);
      expect(signalGroup).not.toHaveBeenCalled();
      expect(fatalExit).not.toHaveBeenCalled();
      expect(lifecycle).not.toHaveBeenCalled();
      expect((await probeRuntime(server.socketPath))?.queueWaitMs.maximum).toBeGreaterThan(100);
    } finally {
      finishFirst(emptyRecognition());
      firstClient.close();
      waitingClient.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    'deducts queue wait and preserves recycle timing (native timeout: %s)',
    async (nativeTimeout) => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-queued-budget-'));
      const environment = sandboxEnvironment(join(directory, 'ocr.sock'));
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let finishFirst!: (result: ReturnType<typeof emptyRecognition>) => void;
      const firstResult = new Promise<ReturnType<typeof emptyRecognition>>((resolve) => {
        finishFirst = resolve;
      });
      let calls = 0;
      const fatalExit = jest.fn();
      const previousExitCode = process.exitCode;
      const recordLifecycleEvent = jest.fn<
        ReturnType<NativeOcrSandboxServerDependencies['recordLifecycleEvent']>,
        Parameters<NativeOcrSandboxServerDependencies['recordLifecycleEvent']>
      >();
      const runNative = jest.fn(
        async (
          _options: Parameters<NativeOcrSandboxServerDependencies['runNativeTesseract']>[0],
        ) => {
          if (++calls === 1) {
            markStarted();
            return firstResult;
          }
          return nativeTimeout
            ? { ok: false as const, reason: 'timeout' as const }
            : emptyRecognition();
        },
      );
      const server = await startNativeOcrSandboxServer(environment, {
        ...successfulServerDependencies(),
        runNativeTesseract: runNative,
        fatalExit,
        recordLifecycleEvent,
      });
      const firstClient = new NativeOcrSandboxClient(testClientConfig(environment));
      const waitingClient = new NativeOcrSandboxClient(testClientConfig(environment));
      try {
        const first = firstClient.recognize(Buffer.from('first-input'), 6, 3_000);
        await started;
        const waiting = waitingClient
          .recognize(Buffer.from('private-waiting-input'), 11, 1_000)
          .catch(() => undefined);
        const during = await waitForQueuedRuntime(server.socketPath);
        expect(during.remainingBudgetMs).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const afterWait = await probeRuntime(server.socketPath);
        expect(afterWait?.activeOperation).toBe('recognize');
        expect(afterWait?.remainingBudgetMs).toBeLessThan(during.remainingBudgetMs! - 100);
        finishFirst(emptyRecognition());
        await expect(first).resolves.toMatchObject({ ok: true });
        const waitingResult = await waiting;
        if (!nativeTimeout) expect(waitingResult).toMatchObject({ ok: true });
        expect(runNative.mock.calls[1]![0].timeoutMs).toBeLessThan(900);
        expect(runNative.mock.calls[1]![0].timeoutMs).toBeGreaterThan(1);
        if (nativeTimeout) {
          await waitFor(() => fatalExit.mock.calls.length > 0);
          expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
          const diagnostic = recordLifecycleEvent.mock.calls[0]![0];
          expect(diagnostic).toMatchObject({
            reason: 'native_timeout',
            operation: 'recognize',
            psm: 11,
            preprocessPass: 'unavailable',
            payloadBytes: Buffer.byteLength('private-waiting-input'),
            requestedTimeoutMs: 1_000,
            executionBudgetMs: runNative.mock.calls[1]![0].timeoutMs,
          });
          expect(diagnostic.queueWaitMs).toBeGreaterThanOrEqual(100);
          expect(diagnostic.operationElapsedMs).toBeGreaterThanOrEqual(0);
          expect(JSON.stringify(diagnostic)).not.toMatch(/first-input|private-waiting-input/u);
          expect(fatalExit).toHaveBeenCalledTimes(1);
          return;
        }
        expect(recordLifecycleEvent).not.toHaveBeenCalled();
        const after = await probeRuntime(server.socketPath);
        expect(after).toMatchObject({
          activeOperation: 'idle',
          remainingBudgetMs: null,
          queueDepth: 0,
          counters: { started: 2, completed: 2, failed: 0 },
        });
        expect(after?.counters.probes).toBeGreaterThanOrEqual(2);
        expect(after?.queueWaitMs.maximum).toBeGreaterThanOrEqual(100);
      } finally {
        process.exitCode = previousExitCode;
        finishFirst(emptyRecognition());
        firstClient.close();
        waitingClient.close();
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

function emptyRecognition() {
  return {
    ok: true as const,
    payload: { text: '', aggregateConfidence: null, words: [], lines: [], truncated: false },
  };
}

async function probeRuntime(socketPath: string) {
  return new Promise<ReturnType<typeof parseNativeOcrSandboxRuntimeStatus>>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Test probe timed out'));
    }, 2_000);
    socket.once('connect', () =>
      socket.write(
        encodeNativeOcrSandboxFrame({
          kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest,
          metadata: {},
          limits: { metadataBytes: 4 * 1024, payloadBytes: 0 },
        }),
      ),
    );
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const frame = decodeNativeOcrSandboxFrame(Buffer.concat(chunks), {
          metadataBytes: 64 * 1024,
          payloadBytes: 0,
        });
        resolve(parseNativeOcrSandboxRuntimeStatus(frame.metadata.runtimeStatus));
      } catch (error) {
        reject(error);
      } finally {
        clearTimeout(timer);
        socket.destroy();
      }
    });
  });
}

async function waitForQueuedRuntime(socketPath: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const status = await probeRuntime(socketPath);
    if (status?.queueDepth === 1) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Expected a real queued sandbox request');
}

function sandboxEnvironment(socketPath: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    HOME: '/home/node',
    LANG: 'C.UTF-8',
    NODE_ENV: 'test',
    OMP_THREAD_LIMIT: '1',
    COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: socketPath,
    COMMERCIAL_OCR_TESSERACT_CONCURRENCY: '1',
    COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: '4',
    COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '10000',
  };
}

function successfulServerDependencies(): Partial<NativeOcrSandboxServerDependencies> {
  return {
    allowTestSocketPath: true,
    networkInterfaces: (() => ({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    })) as NativeOcrSandboxServerDependencies['networkInterfaces'],
    verifyNativeIdentity: async (_config, expected) => ({
      verified: true,
      status: 'verified',
      mismatches: [],
      identity: { ...expected, complete: true },
    }),
    probeNativeTesseract: jest.fn(
      async () => ({ ok: true }) as const,
    ) as NativeOcrSandboxServerDependencies['probeNativeTesseract'],
    fatalExit: jest.fn(),
    recordLifecycleEvent: jest.fn(),
  };
}

function testClientConfig(environment: NodeJS.ProcessEnv) {
  return {
    get: (key: string): unknown => (key === 'NODE_ENV' ? 'test' : environment[key]),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadlineAt = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadlineAt) throw new Error('Timed out waiting for sandbox test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
