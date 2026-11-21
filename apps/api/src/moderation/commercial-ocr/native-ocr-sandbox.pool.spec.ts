import { ConfigService } from '@nestjs/config';
import {
  NativeOcrSandboxClient,
  NativeOcrSandboxRequestTimeoutError,
  NativeOcrSandboxUnavailableError,
} from './native-ocr-sandbox.client';
import type { NativeTesseractRunResult } from './native-tesseract-runner';
import { NativeOcrSandboxPool } from './native-ocr-sandbox.pool';
import {
  NATIVE_OCR_SANDBOX_DEFAULT_SOCKET_PATH,
  NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS,
  NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS_ENV,
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
} from './native-ocr-sandbox.protocol';

const COMPLETE_PASS: NativeTesseractRunResult = {
  ok: true,
  payload: {
    text: '',
    words: [],
    lines: [],
    aggregateConfidence: null,
    truncated: false,
  },
};

describe('native OCR pool', () => {
  afterEach(() => jest.restoreAllMocks());

  function createPool() {
    return new NativeOcrSandboxPool(
      new ConfigService({
        [NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV]: NATIVE_OCR_SANDBOX_DEFAULT_SOCKET_PATH,
        [NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS_ENV]: NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS,
      }),
    );
  }

  it('shares three slots across preprocessing and recognition and refuses a fourth before dispatch', async () => {
    const pool = createPool();
    const completed: (() => void)[] = [];
    jest.spyOn(NativeOcrSandboxClient.prototype, 'isVerified').mockReturnValue(true);
    const recognize = jest
      .spyOn(NativeOcrSandboxClient.prototype, 'recognize')
      .mockImplementation(
        () => new Promise((resolve) => completed.push(() => resolve(COMPLETE_PASS))),
      );
    const preprocess = jest
      .spyOn(NativeOcrSandboxClient.prototype, 'preprocess')
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            completed.push(() => resolve({ bytes: Buffer.alloc(1), width: 1, height: 1 })),
          ),
      );
    try {
      const active = [
        pool.preprocess(Buffer.alloc(1), 'primary', 1000),
        pool.recognize(Buffer.alloc(1), 11, 1000),
        pool.recognize(Buffer.alloc(1), 11, 1000),
      ];
      await expect(pool.preprocess(Buffer.alloc(1), 'primary', 1000)).rejects.toMatchObject({
        reason: 'capacity_exhausted',
      });
      expect(new Set([...recognize.mock.contexts, ...preprocess.mock.contexts]).size).toBe(3);
      completed.splice(0).forEach((finish) => finish());
      await Promise.all(active);
      const next = pool.recognize(Buffer.alloc(1), 11, 1000);
      expect(completed).toHaveLength(1);
      completed[0]!();
      await expect(next).resolves.toBe(COMPLETE_PASS);
    } finally {
      pool.close();
    }
  });

  it('routes later work through healthy lanes after a deadline with uncertain completion', async () => {
    const pool = createPool();
    const invalid = new Set<NativeOcrSandboxClient>();
    jest.spyOn(NativeOcrSandboxClient.prototype, 'isVerified').mockImplementation(function (
      this: NativeOcrSandboxClient,
    ) {
      return !invalid.has(this);
    });
    jest
      .spyOn(NativeOcrSandboxClient.prototype, 'invalidateVerification')
      .mockImplementation(function (this: NativeOcrSandboxClient) {
        invalid.add(this);
      });
    const recognize = jest
      .spyOn(NativeOcrSandboxClient.prototype, 'recognize')
      .mockRejectedValueOnce(new NativeOcrSandboxRequestTimeoutError())
      .mockResolvedValue(COMPLETE_PASS);
    try {
      await expect(pool.recognize(Buffer.alloc(1), 11, 1000)).rejects.toBeInstanceOf(
        NativeOcrSandboxRequestTimeoutError,
      );
      expect(recognize).toHaveBeenCalledTimes(1);
      expect(pool.getStatuses().map((status) => status.verified)).toEqual([false, true, true]);
      for (let i = 0; i < 4; i++) {
        await expect(pool.recognize(Buffer.alloc(1), 11, 1000)).resolves.toBe(COMPLETE_PASS);
      }
      expect(new Set(recognize.mock.contexts.slice(1)).size).toBe(2);
      expect(recognize.mock.contexts.slice(1)).not.toContain(recognize.mock.contexts[0]);
    } finally {
      pool.close();
    }
  });

  it('reprobes all lanes independently even if one is unavailable', async () => {
    const pool = createPool();
    const verification = { verified: true } as Awaited<ReturnType<NativeOcrSandboxClient['probe']>>;
    const probe = jest
      .spyOn(NativeOcrSandboxClient.prototype, 'probe')
      .mockRejectedValueOnce(new NativeOcrSandboxUnavailableError('unavailable'))
      .mockResolvedValue(verification);
    try {
      await expect(pool.probe()).resolves.toBe(verification);
      expect(new Set(probe.mock.contexts).size).toBe(3);
    } finally {
      pool.close();
    }
  });
});
