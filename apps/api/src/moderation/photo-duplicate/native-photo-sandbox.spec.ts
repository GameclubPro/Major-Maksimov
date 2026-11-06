import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PhotoFingerprintService } from './photo-fingerprint';
import { NativePhotoSandboxClient } from './native-photo-sandbox.client';
import { startNativePhotoSandbox } from './native-photo-sandbox.server';
import { runNativePhotoWorker } from './native-photo-runner';
import {
  decodePhotoFrame,
  encodePhotoFrame,
  PHOTO_NATIVE_MAX_BYTES,
  PHOTO_NATIVE_MAX_PIXELS,
  PHOTO_NATIVE_MIN_WORK_MS,
  PHOTO_NATIVE_TEARDOWN_GRACE_MS,
  photoFrameLength,
  parsePhotoRequest,
  parsePhotoResult,
  type NativePhotoRequest,
  type NativePhotoResult,
} from './native-photo-sandbox.protocol';
import { PHOTO_RECOMPRESSION_VERSION } from './photo-recompression-version';

const request = (): NativePhotoRequest => ({
  operation: 'fingerprint',
  deadlineAtMs: Date.now() + 10_000,
  maxInputBytes: PHOTO_NATIVE_MAX_BYTES,
  maxInputPixels: PHOTO_NATIVE_MAX_PIXELS,
  remainingEncodedBytes: PHOTO_NATIVE_MAX_BYTES * 2,
  remainingPixels: PHOTO_NATIVE_MAX_PIXELS * 2,
});
const workerOptions = {
  workerPath: join(__dirname, 'native-photo-worker.ts'),
  execArgv: ['--import', require.resolve('tsx')],
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('native photo proof transport', () => {
  it('rejects malformed pair boundaries and mismatched proof versions', () => {
    expect(() =>
      parsePhotoRequest({ ...request(), operation: 'verify_recompression', originalBytes: 0 }),
    ).toThrow('boundary');
    expect(() => parsePhotoRequest({ ...request(), originalBytes: 2 })).toThrow('boundary');
    expect(() =>
      parsePhotoResult({
        kind: 'recompression',
        matched: true,
        proof: { version: 'old', originalHash: 'a'.repeat(64), currentHash: 'b'.repeat(64) },
        decodeCost: { encodedBytes: 10, pixels: 20 },
      }),
    ).toThrow('proof');
  });
  it('rejects overlarge declarations before allocating payloads and ignores no trailing data', () => {
    const valid = encodePhotoFrame({ operation: 'probe' });
    expect(decodePhotoFrame(valid, 0)).toEqual({
      metadata: { operation: 'probe' },
      payload: Buffer.alloc(0),
    });
    const oversize = Buffer.from(valid);
    oversize.writeUInt32BE(PHOTO_NATIVE_MAX_BYTES + 1, 8);
    expect(() => photoFrameLength(oversize)).toThrow('bounds');
    expect(() => decodePhotoFrame(Buffer.concat([valid, Buffer.from('extra')]))).toThrow('length');
  });

  it('rejects a sandbox with an external network before opening its socket', async () => {
    await expect(
      startNativePhotoSandbox(
        {},
        { networkInterfaces: () => ({ eth0: [{ internal: false } as never] }) },
      ),
    ).rejects.toThrow('network-isolated');
  });
});

describe('native photo process lifecycle', () => {
  jest.setTimeout(20_000);

  it.each(['webp', 'jpeg'] as const)(
    'returns hash-bound %s recompression evidence through the isolated worker',
    async (format) => {
      const raw = Buffer.alloc(128 * 128 * 3);
      for (let y = 0; y < 128; y += 1)
        for (let x = 0; x < 128; x += 1) {
          const offset = (y * 128 + x) * 3;
          raw[offset] = 30 + x;
          raw[offset + 1] = 40 + y;
          raw[offset + 2] = 80;
        }
      const source = () => sharp(raw, { raw: { width: 128, height: 128, channels: 3 } });
      const original = await source()[format]({ quality: 92 }).toBuffer();
      const current =
        format === 'jpeg'
          ? await sharp(original).jpeg({ quality: 50 }).toBuffer()
          : await source().webp({ quality: 89 }).toBuffer();
      const actual = await runNativePhotoWorker(
        { ...request(), operation: 'verify_recompression', originalBytes: original.length },
        Buffer.concat([original, current]),
        new AbortController().signal,
        workerOptions,
      );
      expect(actual).toMatchObject({
        kind: 'recompression',
        matched: true,
        proof: {
          version: PHOTO_RECOMPRESSION_VERSION,
          originalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          currentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        decodeCost: { encodedBytes: original.length + current.length, pixels: 128 * 128 * 2 },
      });
      expect(
        await runNativePhotoWorker(
          {
            ...request(),
            operation: 'verify_recompression',
            originalBytes: original.length,
            remainingPixels: 128 * 128,
          },
          Buffer.concat([original, current]),
          new AbortController().signal,
          workerOptions,
        ),
      ).toEqual({ kind: 'rejected', reason: 'album_decode_budget_exceeded' });
      expect(
        await runNativePhotoWorker(
          { ...request(), operation: 'verify_recompression', originalBytes: original.length },
          Buffer.concat([original, Buffer.from('not an image')]),
          new AbortController().signal,
          workerOptions,
        ),
      ).toEqual({ kind: 'rejected', reason: 'unsupported_image' });
    },
  );

  it('preserves exact native raster hashes across format, alpha, orientation and dimensions', async () => {
    const source = sharp({
      create: {
        width: 19,
        height: 11,
        channels: 4,
        background: { r: 12, g: 80, b: 220, alpha: 0.35 },
      },
    });
    const fixtures = [
      await source.clone().png().toBuffer(),
      await source.clone().flatten().jpeg().toBuffer(),
      await source.clone().webp({ lossless: true }).toBuffer(),
      await source.clone().tiff().toBuffer(),
      await source.clone().avif().toBuffer(),
      await source.clone().withMetadata({ orientation: 6 }).png().toBuffer(),
      await source.clone().resize(11, 19).png().toBuffer(),
    ];
    const local = new PhotoFingerprintService({ canonicalOnly: true });
    for (const bytes of fixtures) {
      const expected = await local.fingerprint(bytes);
      const actual = await runNativePhotoWorker(
        request(),
        bytes,
        new AbortController().signal,
        workerOptions,
      );
      expect(actual).toEqual({ kind: 'complete', fingerprint: expected });
    }
  });

  it('kills and reaps a hanging native worker before a subsequent normal decode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-worker-'));
    try {
      const marker = join(directory, 'pid');
      const worker = join(directory, 'hang.cjs');
      await writeFile(
        worker,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdin.resume(); setInterval(() => {}, 1000);`,
      );
      const actual = await runNativePhotoWorker(
        { ...request(), deadlineAtMs: Date.now() + 700 },
        Buffer.from('image'),
        new AbortController().signal,
        { workerPath: worker },
      );
      expect(actual).toEqual({ kind: 'rejected', reason: 'decode_deadline_exceeded' });
      expect(alive(Number(await readFile(marker, 'utf8')))).toBe(false);
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
        .png()
        .toBuffer();
      expect(
        await runNativePhotoWorker(request(), bytes, new AbortController().signal, workerOptions),
      ).toMatchObject({ kind: 'complete' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not inherit API credentials or NODE_OPTIONS into workers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-worker-'));
    process.env.MAXIM_PHOTO_TEST_SECRET = 'must-not-cross';
    try {
      const worker = join(directory, 'environment.cjs');
      await writeFile(
        worker,
        `process.stdin.resume(); process.stdin.on('end', () => { if (process.env.MAXIM_PHOTO_TEST_SECRET || process.env.NODE_OPTIONS) process.exit(9); process.stdout.write(JSON.stringify({kind:'rejected',reason:'unsupported_image'})); });`,
      );
      expect(
        await runNativePhotoWorker(request(), Buffer.from('image'), new AbortController().signal, {
          workerPath: worker,
        }),
      ).toEqual({ kind: 'rejected', reason: 'unsupported_image' });
    } finally {
      delete process.env.MAXIM_PHOTO_TEST_SECRET;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects stdout expansion and reaps the offending process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-worker-'));
    try {
      const marker = join(directory, 'pid');
      const worker = join(directory, 'large.cjs');
      await writeFile(
        worker,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.stdin.resume(); process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000);`,
      );
      expect(
        await runNativePhotoWorker(request(), Buffer.from('image'), new AbortController().signal, {
          workerPath: worker,
        }),
      ).toEqual({ kind: 'rejected', reason: 'native_unavailable' });
      expect(alive(Number(await readFile(marker, 'utf8')))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('native photo sandbox admission', () => {
  it('attests pair support and carries bounded pair verification through the UDS client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-pair-ipc-'));
    const server = await startNativePhotoSandbox(
      { PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock') },
      {
        networkInterfaces: () => ({}),
        allowTestSocketPath: true,
        runWorker: (work, payload, signal) =>
          runNativePhotoWorker(work, payload, signal, workerOptions),
      },
    );
    try {
      const client = new NativePhotoSandboxClient(server.socketPath);
      expect(await client.probe()).toMatchObject({
        recompressionVersion: PHOTO_RECOMPRESSION_VERSION,
      });
      const original = await sharp({
        create: { width: 128, height: 128, channels: 3, background: '#416279' },
      })
        .png()
        .toBuffer();
      const current = await sharp(original).webp({ lossless: true }).toBuffer();
      expect(await client.verifyRecompression(original, current, request())).toMatchObject({
        kind: 'recompression',
        matched: true,
      });
      expect(
        await client.verifyRecompression(original, current, {
          ...request(),
          maxInputBytes: original.length,
        }),
      ).toEqual({ kind: 'rejected', reason: 'image_byte_limit_exceeded' });
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([0, 499, 500, 800, 999])(
    'rejects budget %s before launching a child and keeps the next request usable',
    async (remainingMs) => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-ipc-'));
      const runWorker = jest.fn(
        async (_request: NativePhotoRequest): Promise<NativePhotoResult> => ({
          kind: 'rejected',
          reason: 'unsupported_image',
        }),
      );
      const fatalExit = jest.fn();
      const server = await startNativePhotoSandbox(
        { PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock') },
        {
          networkInterfaces: () => ({}),
          allowTestSocketPath: true,
          runWorker,
          fatalExit,
        },
      );
      const instant = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(instant);
      try {
        const client = new NativePhotoSandboxClient(server.socketPath);
        expect(
          await client.fingerprint(Buffer.from('late'), {
            ...request(),
            deadlineAtMs: instant + remainingMs,
          }),
        ).toEqual({ kind: 'rejected', reason: 'decode_deadline_exceeded' });
        expect(runWorker).not.toHaveBeenCalled();
        const next = {
          ...request(),
          deadlineAtMs: instant + PHOTO_NATIVE_TEARDOWN_GRACE_MS + PHOTO_NATIVE_MIN_WORK_MS,
        };
        expect(await client.fingerprint(Buffer.from('fresh'), next)).toEqual({
          kind: 'rejected',
          reason: 'unsupported_image',
        });
        expect(runWorker).toHaveBeenCalledTimes(1);
        expect(runWorker.mock.calls[0]![0]).toMatchObject({
          deadlineAtMs: next.deadlineAtMs - PHOTO_NATIVE_TEARDOWN_GRACE_MS,
        });
        expect(fatalExit).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('holds the sole execution slot until physical teardown settles, independently of OCR', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-ipc-'));
    const started = deferred();
    const release = deferred();
    const runWorker = jest.fn(async (): Promise<NativePhotoResult> => {
      started.resolve();
      await release.promise;
      return { kind: 'rejected', reason: 'unsupported_image' };
    });
    const environment = {
      PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock'),
      SECRET: 'not-allowed',
    };
    const server = await startNativePhotoSandbox(environment, {
      networkInterfaces: () => ({}),
      allowTestSocketPath: true,
      runWorker,
    });
    try {
      expect(environment).not.toHaveProperty('SECRET');
      const client = new NativePhotoSandboxClient(server.socketPath);
      expect(await client.probe()).toMatchObject({ network: 'none', environment: 'allowlist' });
      const first = client.fingerprint(Buffer.from('first'), request());
      await started.promise;
      expect(await client.fingerprint(Buffer.from('second'), request())).toEqual({
        kind: 'rejected',
        reason: 'decode_capacity_exceeded',
      });
      expect(runWorker).toHaveBeenCalledTimes(1);
      release.resolve();
      await first;
      expect(await client.fingerprint(Buffer.from('third'), request())).toEqual({
        kind: 'rejected',
        reason: 'unsupported_image',
      });
      expect(runWorker).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('poisons and recycles the sandbox when containment cannot be verified', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-ipc-'));
    const fatalExit = jest.fn();
    const recordLifecycleEvent = jest.fn();
    const { PhotoNativeContainmentError } = await import('./native-photo-runner');
    const runWorker = jest.fn(async (): Promise<NativePhotoResult> => {
      throw new PhotoNativeContainmentError('unreaped');
    });
    const server = await startNativePhotoSandbox(
      { PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock') },
      {
        networkInterfaces: () => ({}),
        allowTestSocketPath: true,
        runWorker,
        fatalExit,
        recordLifecycleEvent,
      },
    );
    try {
      const client = new NativePhotoSandboxClient(server.socketPath);
      await expect(client.fingerprint(Buffer.from('first'), request())).rejects.toThrow(
        'transport',
      );
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(fatalExit).toHaveBeenCalledTimes(1);
      expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
      expect(recordLifecycleEvent).toHaveBeenCalledWith({
        event: 'native_photo_sandbox_recycle',
        reason: 'process_group_teardown_failed',
        operation: 'fingerprint',
      });
      await expect(client.fingerprint(Buffer.from('second'), request())).rejects.toThrow(
        'transport',
      );
      expect(runWorker).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['decode_deadline_exceeded', 'native_unavailable'] as const)(
    'records only the bounded %s reason and still recycles if the sink fails',
    async (reason) => {
      const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-ipc-'));
      const fatalExit = jest.fn();
      const recordLifecycleEvent = jest.fn(() => {
        throw new Error('diagnostic unavailable');
      });
      const runWorker = jest.fn(
        async (): Promise<NativePhotoResult> => ({ kind: 'rejected', reason }),
      );
      const server = await startNativePhotoSandbox(
        { PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock') },
        {
          networkInterfaces: () => ({}),
          allowTestSocketPath: true,
          runWorker,
          fatalExit,
          recordLifecycleEvent,
        },
      );
      try {
        const client = new NativePhotoSandboxClient(server.socketPath);
        await expect(client.fingerprint(Buffer.from('private-image'), request())).resolves.toEqual({
          kind: 'rejected',
          reason,
        });
        await waitFor(() => fatalExit.mock.calls.length > 0);
        expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
        expect(recordLifecycleEvent).toHaveBeenCalledWith({
          event: 'native_photo_sandbox_recycle',
          reason,
          operation: 'fingerprint',
        });
        expect(fatalExit).toHaveBeenCalledTimes(1);
        await expect(client.fingerprint(Buffer.from('second'), request())).rejects.toThrow(
          'transport',
        );
        expect(runWorker).toHaveBeenCalledTimes(1);
      } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('recycles on a stalled diagnostic and never releases poisoned native capacity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-stalled-diagnostic-'));
    const fatalExit = jest.fn();
    const recordLifecycleEvent = jest.fn(() => new Promise<void>(() => {}));
    const runWorker = jest.fn(
      async (): Promise<NativePhotoResult> => ({
        kind: 'rejected',
        reason: 'native_unavailable',
      }),
    );
    const server = await startNativePhotoSandbox(
      { PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock') },
      {
        networkInterfaces: () => ({}),
        allowTestSocketPath: true,
        runWorker,
        fatalExit,
        recordLifecycleEvent,
      },
    );
    try {
      const client = new NativePhotoSandboxClient(server.socketPath);
      await expect(client.fingerprint(Buffer.from('private-image'), request())).resolves.toEqual({
        kind: 'rejected',
        reason: 'native_unavailable',
      });
      await expect(client.fingerprint(Buffer.from('second'), request())).rejects.toThrow(
        'transport',
      );
      // Real socket scheduling varies; the exact 25ms bound is asserted with a fake clock
      // in the shared helper test. This checks that a pending diagnostic cannot cancel exit.
      await server.close();
      await waitFor(() => fatalExit.mock.calls.length > 0);
      expect(recordLifecycleEvent).toHaveBeenCalledTimes(1);
      expect(recordLifecycleEvent).toHaveBeenCalledWith({
        event: 'native_photo_sandbox_recycle',
        reason: 'native_unavailable',
        operation: 'fingerprint',
      });
      expect(fatalExit).toHaveBeenCalledTimes(1);
      expect(runWorker).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the consumer raster smoke through the socket and real native worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-photo-ipc-'));
    const server = await startNativePhotoSandbox(
      { PHOTO_NATIVE_SANDBOX_SOCKET_PATH: join(directory, 'photo.sock') },
      {
        networkInterfaces: () => ({}),
        allowTestSocketPath: true,
        runWorker: (input, payload, signal) =>
          runNativePhotoWorker(input, payload, signal, workerOptions),
      },
    );
    try {
      await expect(
        new NativePhotoSandboxClient(server.socketPath).smoke(),
      ).resolves.toBeUndefined();
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadlineAt = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadlineAt) throw new Error('Timed out waiting for sandbox test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
