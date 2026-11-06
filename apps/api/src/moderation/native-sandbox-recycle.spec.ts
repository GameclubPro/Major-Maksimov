import { write } from 'node:fs';
import {
  createNativeSandboxRecycle,
  NATIVE_SANDBOX_DIAGNOSTIC_FLUSH_MAX_MS,
  writeNativeSandboxLifecycleEvent,
} from './native-sandbox-recycle';

jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), write: jest.fn() }));

const event = {
  event: 'native_photo_sandbox_recycle',
  reason: 'native_unavailable',
  operation: 'fingerprint',
} as const;

describe('bounded native sandbox recycle diagnostic', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  it.each(['resolve', 'reject', 'throw'] as const)(
    'exits once after a diagnostic sink %s without delaying admission closure',
    async (outcome) => {
      const fatalExit = jest.fn();
      const recordLifecycleEvent = jest.fn(() => {
        if (outcome === 'throw') throw new Error('sink failed');
        return outcome === 'reject' ? Promise.reject(new Error('sink failed')) : Promise.resolve();
      });
      const recycle = createNativeSandboxRecycle({ fatalExit, recordLifecycleEvent });
      recycle(event);
      recycle(event);
      await jest.advanceTimersByTimeAsync(0);
      expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
      expect(recordLifecycleEvent).toHaveBeenCalledWith(event);
      expect(fatalExit).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(NATIVE_SANDBOX_DIAGNOSTIC_FLUSH_MAX_MS * 2);
      expect(fatalExit).toHaveBeenCalledTimes(1);
    },
  );

  it('exits at the hard bound when a diagnostic never settles', async () => {
    const fatalExit = jest.fn();
    let resolveSink!: () => void;
    const recordLifecycleEvent = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSink = resolve;
        }),
    );
    const recycle = createNativeSandboxRecycle({ fatalExit, recordLifecycleEvent });
    recycle(event);
    await jest.advanceTimersByTimeAsync(NATIVE_SANDBOX_DIAGNOSTIC_FLUSH_MAX_MS - 1);
    expect(fatalExit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(fatalExit).toHaveBeenCalledTimes(1);
    resolveSink();
    recycle(event);
    await jest.advanceTimersByTimeAsync(NATIVE_SANDBOX_DIAGNOSTIC_FLUSH_MAX_MS);
    expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(fatalExit).toHaveBeenCalledTimes(1);
  });

  it('writes one bounded identifier-free event asynchronously to stderr', async () => {
    const writeMock = write as unknown as jest.Mock;
    const pending = writeNativeSandboxLifecycleEvent(event);
    expect(writeMock).toHaveBeenCalledWith(2, `${JSON.stringify(event)}\n`, expect.any(Function));
    const callback = writeMock.mock.calls[0]?.[2] as (error: Error | null) => void;
    callback(null);
    await expect(pending).resolves.toBeUndefined();
  });

  it('handles a stalled real write callback with the same exit bound', async () => {
    const fatalExit = jest.fn();
    const recycle = createNativeSandboxRecycle({
      fatalExit,
      recordLifecycleEvent: writeNativeSandboxLifecycleEvent,
    });
    recycle(event);
    await jest.advanceTimersByTimeAsync(NATIVE_SANDBOX_DIAGNOSTIC_FLUSH_MAX_MS);
    expect(write).toHaveBeenCalledTimes(1);
    expect(fatalExit).toHaveBeenCalledTimes(1);
    const callback = (write as unknown as jest.Mock).mock.calls[0]?.[2] as (
      error: Error | null,
    ) => void;
    callback(new Error('late failed write'));
    await jest.advanceTimersByTimeAsync(NATIVE_SANDBOX_DIAGNOSTIC_FLUSH_MAX_MS);
    expect(fatalExit).toHaveBeenCalledTimes(1);
  });

  it('does not write diagnostic data exceeding its byte bound', async () => {
    await expect(
      writeNativeSandboxLifecycleEvent({ ...event, reason: 'x'.repeat(512) }),
    ).rejects.toThrow('exceeds its bound');
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { operation: 'recognize', psm: 11, preprocessPass: 'unavailable' },
    { operation: 'preprocess', psm: 'unavailable', preprocessPass: 'confirmation' },
  ] as const)(
    'keeps maximal OCR $operation attribution within the existing byte bound',
    async (attribution) => {
      const diagnostic = {
        event: 'native_ocr_sandbox_recycle',
        reason: 'process_group_teardown_failed',
        ...attribution,
        payloadBytes: Number.MAX_SAFE_INTEGER,
        queueDepth: Number.MAX_SAFE_INTEGER,
        pendingBytes: Number.MAX_SAFE_INTEGER,
        requestedTimeoutMs: Number.MAX_SAFE_INTEGER,
        executionBudgetMs: Number.MAX_SAFE_INTEGER,
        queueWaitMs: Number.MAX_SAFE_INTEGER,
        operationElapsedMs: Number.MAX_SAFE_INTEGER,
      };
      const line = `${JSON.stringify(diagnostic)}\n`;
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(512);
      const pending = writeNativeSandboxLifecycleEvent(diagnostic);
      const writeMock = write as unknown as jest.Mock;
      expect(writeMock).toHaveBeenCalledWith(2, line, expect.any(Function));
      const callback = writeMock.mock.calls[0]![2] as (error: Error | null) => void;
      callback(null);
      await expect(pending).resolves.toBeUndefined();
    },
  );
});
