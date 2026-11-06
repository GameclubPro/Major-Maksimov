import sharp from 'sharp';
import { PDQ } from 'pdq-wasm';
import { createHash } from 'node:crypto';
import { NativePhotoSandboxClient } from './native-photo-sandbox.client';
import type { NativePhotoFingerprintResult } from './native-photo-sandbox.protocol';
import type { PhotoRecompressionResult } from './photo-recompression';
import { PHOTO_RECOMPRESSION_VERSION } from './photo-recompression-version';
import { PhotoDecodeBudget } from './photo-decode-resource';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  PhotoFingerprintRejectedError,
  PhotoFingerprintService,
  createPhotoAlbumFingerprint,
  createPlatformPhotoAlbumHash,
  hammingDistanceHex,
  matchPhotoAlbums,
  type PhotoFingerprint,
} from './photo-fingerprint';

function fingerprintFixture(params: {
  canonicalHash: string;
  pdqHash: string;
  pdqQuality?: number;
}): PhotoFingerprint {
  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    canonicalHash: params.canonicalHash,
    pdqHash: params.pdqHash,
    pdqQuality: params.pdqQuality ?? 80,
  };
}

async function multiPageImage(format: 'gif' | 'webp' | 'tiff'): Promise<Buffer> {
  const width = 8;
  const pageHeight = 6;
  const pages = 2;
  const frameBytes = width * pageHeight * 3;
  const input = Buffer.alloc(frameBytes * pages);
  input.fill(32, 0, frameBytes);
  input.fill(224, frameBytes);
  const image = sharp(input, {
    raw: { width, height: pageHeight * pages, channels: 3, pageHeight },
  });

  if (format === 'gif') {
    return image.gif({ delay: [100, 100], loop: 0, keepDuplicateFrames: true }).toBuffer();
  }
  if (format === 'webp') {
    return image.webp({ delay: [100, 100], loop: 0 }).toBuffer();
  }
  return image.tiff({ compression: 'deflate' }).toBuffer();
}

async function patternedPhoto(): Promise<Buffer> {
  const width = 320;
  const height = 240;
  const input = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const checker = (Math.floor(x / 32) + Math.floor(y / 24)) % 2 === 0 ? 36 : -24;
      input[offset] = Math.max(0, Math.min(255, (x * 3 + y + checker) % 256));
      input[offset + 1] = Math.max(0, Math.min(255, (x + y * 2 + 80 - checker) % 256));
      input[offset + 2] = Math.max(0, Math.min(255, (x * 2 + y * 3 + 40) % 256));
    }
  }
  return sharp(input, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

describe('PhotoFingerprintService', () => {
  it('separates local slot wait from native roundtrip and survives observer failure', async () => {
    let now = 0;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proof = {
      ...fingerprintFixture({ canonicalHash: 'a'.repeat(64), pdqHash: '0'.repeat(64) }),
      decodeCost: { encodedBytes: 1, pixels: 1 },
    };
    const nativeDecoder = new NativePhotoSandboxClient('/tmp/photo-fingerprint-timing.sock');
    const nativeFingerprint = jest
      .spyOn(nativeDecoder, 'fingerprint')
      .mockImplementationOnce(async () => {
        entered();
        await blocked;
        return { kind: 'complete', fingerprint: proof };
      })
      .mockResolvedValue({ kind: 'complete', fingerprint: proof });
    const timings = {
      recordPhase: jest.fn(() => {
        throw new Error('observer unavailable');
      }),
    };
    const service = new PhotoFingerprintService({
      canonicalOnly: true,
      nativeDecoder,
    });
    try {
      const first = service.fingerprint(Buffer.from('a'), { timings });
      await started;
      now = 10;
      const second = service.fingerprint(Buffer.from('b'), { timings });
      expect(nativeFingerprint).toHaveBeenCalledTimes(1);
      now = 60;
      release();
      await expect(first).resolves.toEqual(proof);
      await expect(second).resolves.toEqual(proof);
      expect(timings.recordPhase.mock.calls).toEqual([
        ['decode_wait', 0],
        ['native_roundtrip', 60],
        ['decode_wait', 50],
        ['native_roundtrip', 0],
      ]);
      expect(nativeFingerprint.mock.calls[0]![1]).not.toHaveProperty('timings');
      const original = new Error('native transport unavailable');
      nativeFingerprint.mockRejectedValueOnce(original);
      await expect(service.fingerprint(Buffer.from('c'), { timings })).rejects.toMatchObject({
        name: 'PhotoNativeUnavailableError',
        cause: original,
      });
    } finally {
      release();
      clock.mockRestore();
    }
  });

  it('does not erase a changed native pixel through thumbnail downsampling', async () => {
    const width = 2048;
    const input = Buffer.alloc(width * width * 3, 255);
    const original = await sharp(input, { raw: { width, height: width, channels: 3 } })
      .png()
      .toBuffer();
    input[(1024 * width + 1024) * 3] = 254;
    const changed = await sharp(input, { raw: { width, height: width, channels: 3 } })
      .png()
      .toBuffer();
    const service = new PhotoFingerprintService({ canonicalOnly: true });
    expect((await service.fingerprint(changed)).canonicalHash).not.toBe(
      (await service.fingerprint(original)).canonicalHash,
    );
  });

  it('preserves native dimensions and transparency in exact equality', async () => {
    const service = new PhotoFingerprintService({ canonicalOnly: true });
    const hash = async (width: number, height: number, alpha: number) =>
      (
        await service.fingerprint(
          await sharp({
            create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha } },
          })
            .png()
            .toBuffer(),
        )
      ).canonicalHash;
    const original = await hash(64, 64, 1);
    expect(await hash(128, 128, 1)).not.toBe(original);
    expect(await hash(64, 32, 1)).not.toBe(original);
    expect(await hash(64, 64, 0)).not.toBe(original);
  });

  it('rejects high-bit-depth pixels instead of silently quantizing exact evidence', async () => {
    const encoded = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#447799' },
    })
      .toColourspace('rgb16')
      .png()
      .toBuffer();
    expect((await sharp(encoded).metadata()).depth).toBe('ushort');
    await expect(
      new PhotoFingerprintService({ canonicalOnly: true }).fingerprint(encoded),
    ).rejects.toMatchObject({ reason: 'unsupported_image' });
  });

  it('preserves exact equality across EXIF orientation and lossless container metadata', async () => {
    const original = await patternedPhoto();
    const rotated = await sharp(original)
      .rotate(90)
      .withMetadata({ orientation: 8 })
      .png()
      .toBuffer();
    const service = new PhotoFingerprintService({ canonicalOnly: true });
    expect((await service.fingerprint(rotated)).canonicalHash).toBe(
      (await service.fingerprint(original)).canonicalHash,
    );
  });

  it('does not initialize or compute perceptual hashes in production canonical-only mode', async () => {
    const init = jest.spyOn(PDQ, 'init');
    const hash = jest.spyOn(PDQ, 'hash');
    try {
      const service = new PhotoFingerprintService({ canonicalOnly: true });
      await service.onModuleInit();
      const result = await service.fingerprint(await patternedPhoto());
      expect(result.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.pdqQuality).toBe(0);
      expect(init).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
    } finally {
      init.mockRestore();
      hash.mockRestore();
    }
  });
  it('proves exact pixels across PNG and lossless WebP but distinguishes different images', async () => {
    const png = await patternedPhoto();
    const webp = await sharp(png).webp({ lossless: true }).toBuffer();
    const changed = await sharp(png).negate().png().toBuffer();
    const service = new PhotoFingerprintService();
    const originalHash = (await service.fingerprint(png)).canonicalHash;
    expect((await service.fingerprint(webp)).canonicalHash).toBe(originalHash);
    expect((await service.fingerprint(changed)).canonicalHash).not.toBe(originalHash);
  });
  it('normalizes an encoded image and initializes PDQ from the local Node package', async () => {
    const input = Buffer.alloc(96 * 64 * 3);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 96; x += 1) {
        const offset = (y * 96 + x) * 3;
        input[offset] = (x * 13 + y * 3) % 256;
        input[offset + 1] = (x * 5 + y * 17) % 256;
        input[offset + 2] = (x * 19 + y * 7) % 256;
      }
    }
    const png = await sharp(input, { raw: { width: 96, height: 64, channels: 3 } })
      .png()
      .toBuffer();
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network access is forbidden in the PDQ smoke test'));

    try {
      const fingerprint = await new PhotoFingerprintService().fingerprint(png);

      expect(fingerprint).toEqual({
        algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        canonicalHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        recompressionHash: expect.stringMatching(/^[0-9a-f]{16}$/),
        pdqHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        pdqQuality: expect.any(Number),
        decodeCost: { encodedBytes: expect.any(Number), pixels: expect.any(Number) },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('matches real recompression and bounded visual edits with the advertised presets', async () => {
    const original = await patternedPhoto();
    const recompressed = await sharp(original)
      .resize({ width: 220 })
      .jpeg({ quality: 72 })
      .toBuffer();
    const lightlyEdited = await sharp(original)
      .extract({ left: 4, top: 3, width: 312, height: 234 })
      .modulate({ brightness: 1.02, saturation: 0.96, hue: 2 })
      .jpeg({ quality: 78 })
      .toBuffer();
    const service = new PhotoFingerprintService();
    const [baseFingerprint, recompressedFingerprint, editedFingerprint] = await Promise.all([
      service.fingerprint(original, { expectedFormat: 'png' }),
      service.fingerprint(recompressed, { expectedFormat: 'jpeg' }),
      service.fingerprint(lightlyEdited, { expectedFormat: 'jpeg' }),
    ]);
    const baseAlbum = createPhotoAlbumFingerprint([baseFingerprint]);

    expect(
      matchPhotoAlbums(baseAlbum, createPhotoAlbumFingerprint([recompressedFingerprint]), {
        preset: 'SAME_IMAGE',
      }),
    ).toEqual(
      expect.objectContaining({
        matched: true,
        usedPerceptualHash: true,
      }),
    );
    expect(
      matchPhotoAlbums(baseAlbum, createPhotoAlbumFingerprint([editedFingerprint]), {
        preset: 'MINOR_EDITS',
      }),
    ).toEqual(
      expect.objectContaining({
        matched: true,
        usedPerceptualHash: true,
      }),
    );
  });

  it('rejects oversized encoded input before decoding', async () => {
    await expect(
      new PhotoFingerprintService({ maxInputBytes: 4 }).fingerprint(Buffer.alloc(5)),
    ).rejects.toMatchObject({ reason: 'image_byte_limit_exceeded' });
  });

  it('reports a decoder pixel limit distinctly without reserving album budget', async () => {
    const encoded = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#447799' },
    })
      .png()
      .toBuffer();
    const service = new PhotoFingerprintService({ canonicalOnly: true, maxInputPixels: 99 });
    const budget = service.createAlbumDecodeBudget();
    await expect(service.fingerprint(encoded, { albumBudget: budget })).rejects.toMatchObject({
      reason: 'image_pixel_limit_exceeded',
    });
    expect(budget.usage()).toMatchObject({ encodedBytes: 0, pixels: 0 });
  });

  it('rejects when decoder output does not match the format detected from magic bytes', async () => {
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#447799' },
    })
      .png()
      .toBuffer();

    await expect(
      new PhotoFingerprintService().fingerprint(png, { expectedFormat: 'jpeg' }),
    ).rejects.toMatchObject<Partial<PhotoFingerprintRejectedError>>({
      reason: 'unsupported_image',
    });
  });

  it.each(['gif', 'webp', 'tiff'] as const)(
    'rejects multi-frame %s instead of fingerprinting only its first frame',
    async (format) => {
      const encoded = await multiPageImage(format);
      const budget = new PhotoFingerprintService().createAlbumDecodeBudget();

      await expect(
        new PhotoFingerprintService().fingerprint(encoded, {
          albumBudget: budget,
          expectedFormat: format,
        }),
      ).rejects.toMatchObject<Partial<PhotoFingerprintRejectedError>>({
        reason: 'unsupported_multi_frame',
      });
      expect(budget.usage()).toMatchObject({ encodedBytes: 0, pixels: 0 });
    },
  );

  it('enforces one cumulative pixel budget across image decodes in an album', async () => {
    const encoded = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#447799' },
    })
      .png()
      .toBuffer();
    const service = new PhotoFingerprintService({
      maxInputBytes: 1_048_576,
      maxInputPixels: 1_000,
      maxAlbumInputBytes: 1_048_576,
      maxAlbumInputPixels: 150,
    });
    const budget = service.createAlbumDecodeBudget();

    await expect(
      service.fingerprint(encoded, { albumBudget: budget, expectedFormat: 'png' }),
    ).resolves.toEqual(
      expect.objectContaining({ algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION }),
    );
    await expect(
      service.fingerprint(encoded, { albumBudget: budget, expectedFormat: 'png' }),
    ).rejects.toMatchObject<Partial<PhotoFingerprintRejectedError>>({
      reason: 'album_decode_budget_exceeded',
    });
    expect(budget.usage()).toMatchObject({ pixels: 100, maxPixels: 150 });
  });

  it('retries a failed local PDQ initialization and exposes it as a startup hook', async () => {
    jest.resetModules();
    const init = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('broken wasm package'))
      .mockResolvedValueOnce(undefined);
    jest.doMock('pdq-wasm', () => ({
      PDQ: {
        init,
        hash: jest.fn(),
        toHex: jest.fn(),
      },
    }));

    try {
      const isolatedModule = await import('./photo-fingerprint');
      const service = new isolatedModule.PhotoFingerprintService();

      await expect(service.onModuleInit()).rejects.toThrow('broken wasm package');
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(init).toHaveBeenCalledTimes(2);
    } finally {
      jest.dontMock('pdq-wasm');
    }
  });
});

function encodedHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function nativeFingerprintResult(
  bytes: Uint8Array,
): Extract<NativePhotoFingerprintResult, { kind: 'complete' }> {
  return {
    kind: 'complete',
    fingerprint: {
      algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      canonicalHash: encodedHash(bytes),
      recompressionHash: '0'.repeat(16),
      pdqHash: '0'.repeat(64),
      pdqQuality: 0,
      decodeCost: { encodedBytes: bytes.byteLength, pixels: 100 },
    },
  };
}

function nativePairResult(original: Uint8Array, current: Uint8Array): PhotoRecompressionResult {
  return {
    kind: 'recompression',
    matched: true,
    proof: {
      version: PHOTO_RECOMPRESSION_VERSION,
      originalHash: encodedHash(original),
      currentHash: encodedHash(current),
    },
    decodeCost: { encodedBytes: original.byteLength + current.byteLength, pixels: 200 },
  };
}

function nativeContentService(
  limits: { maxInputBytes?: number; maxInputPixels?: number; maxQueuedPipelines?: number } = {},
) {
  const client = new NativePhotoSandboxClient('/tmp/photo-content-memo.sock');
  const fingerprint = jest
    .spyOn(client, 'fingerprint')
    .mockImplementation(async (bytes) => nativeFingerprintResult(bytes));
  const pair = jest
    .spyOn(client, 'verifyRecompression')
    .mockImplementation(async (original, current) => nativePairResult(original, current));
  return {
    service: new PhotoFingerprintService({ ...limits, nativeDecoder: client, canonicalOnly: true }),
    fingerprint,
    pair,
  };
}

function contentDeadline() {
  return { deadlineAtMs: Date.now() + 10_000 };
}

function deferredContentWork() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('native photo content memoization', () => {
  it('measures pair waiting, rejected admission and reuse separately from native work despite observer faults', async () => {
    const s = nativeContentService({ maxQueuedPipelines: 1 });
    const blocked = deferredContentWork();
    const entered = deferredContentWork();
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    let now = 0;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    const timings = {
      recordPhase: jest.fn(() => {
        throw new Error('observer unavailable');
      }),
    };
    s.pair.mockImplementationOnce(async (original, current) => {
      entered.resolve();
      await blocked.promise;
      return nativePairResult(original, current);
    });
    try {
      const first = s.service.verifyRecompression(a, b, { ...contentDeadline(), timings });
      await entered.promise;
      now = 10;
      const second = s.service.verifyRecompression(a, b, { ...contentDeadline(), timings });
      await expect(
        s.service.verifyRecompression(Buffer.from('c'), b, { ...contentDeadline(), timings }),
      ).rejects.toMatchObject({ reason: 'decode_capacity_exceeded' });
      now = 60;
      blocked.resolve();
      await expect(first).resolves.toEqual(nativePairResult(a, b));
      await expect(second).resolves.toEqual(nativePairResult(a, b));
      expect(timings.recordPhase.mock.calls).toEqual([
        ['recompression_decode_wait', 0],
        ['recompression_decode_wait', 0],
        ['recompression_native_roundtrip', 60],
        ['recompression_decode_wait', 50],
        ['recompression_reuse', 0],
      ]);
      expect(s.pair).toHaveBeenCalledTimes(1);
      expect(s.pair.mock.calls[0]![2]).not.toHaveProperty('timings');
      s.pair.mockRejectedValueOnce(new Error('native transport unavailable'));
      await expect(
        s.service.verifyRecompression(Buffer.from('c'), b, { ...contentDeadline(), timings }),
      ).rejects.toMatchObject({ name: 'PhotoNativeUnavailableError' });
      expect(timings.recordPhase.mock.calls.slice(-2)).toEqual([
        ['recompression_decode_wait', 0],
        ['recompression_native_roundtrip', 0],
      ]);
    } finally {
      blocked.resolve();
      clock.mockRestore();
    }
  });

  it('reuses complete fingerprints only for identical bytes and the same expected format', async () => {
    const s = nativeContentService();
    const bytes = Buffer.from('png-content');
    await s.service.fingerprint(bytes);
    await s.service.fingerprint(Buffer.from(bytes));
    expect(s.fingerprint).toHaveBeenCalledTimes(1);
    await s.service.fingerprint(bytes, { expectedFormat: 'png' });
    expect(s.fingerprint).toHaveBeenCalledTimes(2);
    s.fingerprint.mockResolvedValueOnce({ kind: 'rejected', reason: 'unsupported_image' });
    await expect(s.service.fingerprint(bytes, { expectedFormat: 'jpeg' })).rejects.toMatchObject({
      reason: 'unsupported_image',
    });
    expect(s.fingerprint).toHaveBeenCalledTimes(3);
    await s.service.fingerprint(Buffer.from('changed-content'));
    expect(s.fingerprint).toHaveBeenCalledTimes(4);
  });

  it('reuses positive pair proofs only for the ordered pair of identical bytes', async () => {
    const s = nativeContentService();
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    const proof = await s.service.verifyRecompression(a, b, contentDeadline());
    await expect(
      s.service.verifyRecompression(Buffer.from(a), Buffer.from(b), contentDeadline()),
    ).resolves.toEqual(proof);
    expect(s.pair).toHaveBeenCalledTimes(1);
    await s.service.verifyRecompression(b, a, contentDeadline());
    await s.service.verifyRecompression(a, Buffer.from('c'), contentDeadline());
    expect(s.pair).toHaveBeenCalledTimes(3);
  });

  it('returns isolated proof and cost objects for both the first result and later hits', async () => {
    const s = nativeContentService();
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    const first = await s.service.fingerprint(a);
    first.canonicalHash = 'f'.repeat(64);
    first.decodeCost!.pixels = 1;
    const pair = await s.service.verifyRecompression(a, b, contentDeadline());
    Object.assign(pair.proof, { originalHash: 'f'.repeat(64) });
    pair.decodeCost.pixels = 1;
    const next = await s.service.fingerprint(a);
    expect(next).toEqual(nativeFingerprintResult(a).fingerprint);
    next.decodeCost!.pixels = 2;
    await expect(s.service.fingerprint(a)).resolves.toEqual(nativeFingerprintResult(a).fingerprint);
    await expect(s.service.verifyRecompression(a, b, contentDeadline())).resolves.toEqual(
      nativePairResult(a, b),
    );
    expect(s.fingerprint).toHaveBeenCalledTimes(1);
    expect(s.pair).toHaveBeenCalledTimes(1);
  });

  it('copies a fingerprint miss before native work and never caches under mutable caller bytes', async () => {
    const s = nativeContentService();
    const entered = deferredContentWork();
    const release = deferredContentWork();
    s.fingerprint.mockImplementationOnce(async (bytes) => {
      entered.resolve();
      await release.promise;
      return nativeFingerprintResult(bytes);
    });
    const bytes = Buffer.from('a');
    const pending = s.service.fingerprint(bytes);
    await entered.promise;
    bytes[0] = 'b'.charCodeAt(0);
    release.resolve();
    await expect(pending).resolves.toEqual(nativeFingerprintResult(Buffer.from('a')).fingerprint);
    await s.service.fingerprint(Buffer.from('a'));
    expect(s.fingerprint).toHaveBeenCalledTimes(1);
    await s.service.fingerprint(bytes);
    expect(s.fingerprint).toHaveBeenCalledTimes(2);
  });

  it('copies both pair inputs before native work and keeps the memo independent of caller mutation', async () => {
    const s = nativeContentService();
    const entered = deferredContentWork();
    const release = deferredContentWork();
    s.pair.mockImplementationOnce(async (a, b) => {
      entered.resolve();
      await release.promise;
      return nativePairResult(a, b);
    });
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    const pending = s.service.verifyRecompression(a, b, contentDeadline());
    await entered.promise;
    a[0] = 'x'.charCodeAt(0);
    b[0] = 'y'.charCodeAt(0);
    release.resolve();
    await expect(pending).resolves.toEqual(nativePairResult(Buffer.from('a'), Buffer.from('b')));
    await s.service.verifyRecompression(Buffer.from('a'), Buffer.from('b'), contentDeadline());
    expect(s.pair).toHaveBeenCalledTimes(1);
    await s.service.verifyRecompression(a, b, contentDeadline());
    expect(s.pair).toHaveBeenCalledTimes(2);
  });

  it('checks the fingerprint memo again after waiting and hashes the snapshot taken inside the slot', async () => {
    const s = nativeContentService();
    const entered = deferredContentWork();
    const release = deferredContentWork();
    s.fingerprint.mockImplementationOnce(async (bytes) => {
      entered.resolve();
      await release.promise;
      return nativeFingerprintResult(bytes);
    });
    const first = s.service.fingerprint(Buffer.from('z'));
    await entered.promise;
    const changed = Buffer.from('a');
    const second = s.service.fingerprint(changed);
    const repeated = s.service.fingerprint(Buffer.from('z'));
    changed[0] = 'b'.charCodeAt(0);
    release.resolve();
    await first;
    await expect(second).resolves.toEqual(nativeFingerprintResult(Buffer.from('b')).fingerprint);
    await repeated;
    expect(s.fingerprint).toHaveBeenCalledTimes(2);
    await s.service.fingerprint(Buffer.from('a'));
    expect(s.fingerprint).toHaveBeenCalledTimes(3);
    await s.service.fingerprint(Buffer.from('b'));
    expect(s.fingerprint).toHaveBeenCalledTimes(3);
  });

  it('checks the pair memo again after waiting and stores only the stable ordered snapshot key', async () => {
    const s = nativeContentService();
    const entered = deferredContentWork();
    const release = deferredContentWork();
    s.pair.mockImplementationOnce(async (a, b) => {
      entered.resolve();
      await release.promise;
      return nativePairResult(a, b);
    });
    const first = s.service.verifyRecompression(
      Buffer.from('z'),
      Buffer.from('q'),
      contentDeadline(),
    );
    await entered.promise;
    const changed = Buffer.from('a');
    const second = s.service.verifyRecompression(changed, Buffer.from('c'), contentDeadline());
    const repeated = s.service.verifyRecompression(
      Buffer.from('z'),
      Buffer.from('q'),
      contentDeadline(),
    );
    changed[0] = 'b'.charCodeAt(0);
    release.resolve();
    await first;
    await expect(second).resolves.toEqual(nativePairResult(Buffer.from('b'), Buffer.from('c')));
    await repeated;
    expect(s.pair).toHaveBeenCalledTimes(2);
    await s.service.verifyRecompression(Buffer.from('a'), Buffer.from('c'), contentDeadline());
    expect(s.pair).toHaveBeenCalledTimes(3);
    await s.service.verifyRecompression(Buffer.from('b'), Buffer.from('c'), contentDeadline());
    expect(s.pair).toHaveBeenCalledTimes(3);
  });

  it.each([
    { maxEncodedBytes: 100, maxPixels: 150 },
    { maxEncodedBytes: 1, maxPixels: 1_000 },
  ])('charges every cached fingerprint to the cumulative album budget %j', async (limits) => {
    const s = nativeContentService();
    const bytes = Buffer.from('a');
    await s.service.fingerprint(bytes);
    const boundedBudget = new PhotoDecodeBudget(limits);
    await s.service.fingerprint(bytes, { albumBudget: boundedBudget });
    await expect(
      s.service.fingerprint(bytes, { albumBudget: boundedBudget }),
    ).rejects.toMatchObject({ reason: 'album_decode_budget_exceeded' });
    expect(boundedBudget.usage()).toMatchObject({ encodedBytes: 1, pixels: 100 });
    expect(s.fingerprint).toHaveBeenCalledTimes(1);
  });

  it('retains byte admission and rejects invalid native pixel costs before memoizing', async () => {
    const s = nativeContentService({ maxInputBytes: 2, maxInputPixels: 150 });
    await expect(s.service.fingerprint(Buffer.from('abc'))).rejects.toMatchObject({
      reason: 'image_byte_limit_exceeded',
    });
    await expect(
      s.service.verifyRecompression(Buffer.from('ab'), Buffer.from('c'), contentDeadline()),
    ).rejects.toMatchObject({ reason: 'image_byte_limit_exceeded' });
    expect(s.fingerprint).not.toHaveBeenCalled();
    expect(s.pair).not.toHaveBeenCalled();
    s.fingerprint.mockResolvedValueOnce({
      kind: 'complete',
      fingerprint: {
        ...nativeFingerprintResult(Buffer.from('a')).fingerprint,
        decodeCost: { encodedBytes: 1, pixels: 151 },
      },
    });
    await expect(s.service.fingerprint(Buffer.from('a'))).rejects.toMatchObject({
      name: 'PhotoNativeUnavailableError',
    });
    await s.service.fingerprint(Buffer.from('a'));
    await s.service.fingerprint(Buffer.from('a'));
    expect(s.fingerprint).toHaveBeenCalledTimes(2);
  });

  it('rejects expired warmed requests without invoking native work again', async () => {
    const s = nativeContentService();
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    await s.service.fingerprint(a);
    await s.service.verifyRecompression(a, b, contentDeadline());
    const deadlineAtMs = Date.now() - 1;
    await expect(s.service.fingerprint(a, { deadlineAtMs })).rejects.toMatchObject({
      reason: 'decode_deadline_exceeded',
    });
    await expect(s.service.verifyRecompression(a, b, { deadlineAtMs })).rejects.toMatchObject({
      reason: 'decode_deadline_exceeded',
    });
    expect(s.fingerprint).toHaveBeenCalledTimes(1);
    expect(s.pair).toHaveBeenCalledTimes(1);
  });

  it('checks the original deadline again after hashing a warmed input', async () => {
    const s = nativeContentService();
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    await s.service.fingerprint(a);
    await s.service.verifyRecompression(a, b, contentDeadline());
    const deadlineAtMs = Date.now() + 1_000;
    let reads = 0;
    const clock = jest
      .spyOn(Date, 'now')
      .mockImplementation(() => (++reads === 1 ? deadlineAtMs - 1 : deadlineAtMs));
    try {
      await expect(s.service.fingerprint(a, { deadlineAtMs })).rejects.toMatchObject({
        reason: 'decode_deadline_exceeded',
      });
      reads = 0;
      await expect(s.service.verifyRecompression(a, b, { deadlineAtMs })).rejects.toMatchObject({
        reason: 'decode_deadline_exceeded',
      });
      expect(s.fingerprint).toHaveBeenCalledTimes(1);
      expect(s.pair).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('retains the native eight-million-pixel total pair boundary before memoization', async () => {
    const s = nativeContentService();
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    s.pair.mockResolvedValueOnce({
      ...nativePairResult(a, b),
      decodeCost: { encodedBytes: 2, pixels: 8_000_001 },
    });
    await expect(s.service.verifyRecompression(a, b, contentDeadline())).rejects.toMatchObject({
      name: 'PhotoNativeUnavailableError',
    });
    await s.service.verifyRecompression(a, b, contentDeadline());
    await s.service.verifyRecompression(a, b, contentDeadline());
    expect(s.pair).toHaveBeenCalledTimes(2);
  });

  it('does not record a memo hit as another native roundtrip', async () => {
    const s = nativeContentService();
    const timings = { recordPhase: jest.fn() };
    const a = Buffer.from('a');
    await s.service.fingerprint(a, { timings });
    timings.recordPhase.mockClear();
    await s.service.fingerprint(a, { timings });
    expect(timings.recordPhase).not.toHaveBeenCalled();
    expect(s.fingerprint).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected fingerprint or an unavailable native transport', async () => {
    const s = nativeContentService();
    const bytes = Buffer.from('a');
    s.fingerprint.mockResolvedValueOnce({ kind: 'rejected', reason: 'unsupported_image' });
    await expect(s.service.fingerprint(bytes)).rejects.toMatchObject({
      reason: 'unsupported_image',
    });
    s.fingerprint.mockRejectedValueOnce(new Error('unavailable'));
    await expect(s.service.fingerprint(bytes)).rejects.toMatchObject({
      name: 'PhotoNativeUnavailableError',
    });
    await s.service.fingerprint(bytes);
    await s.service.fingerprint(bytes);
    expect(s.fingerprint).toHaveBeenCalledTimes(3);
  });

  it('caches positive pair proofs only, never a negative or failed result', async () => {
    const s = nativeContentService();
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    s.pair.mockResolvedValueOnce({ ...nativePairResult(a, b), matched: false });
    await expect(s.service.verifyRecompression(a, b, contentDeadline())).resolves.toMatchObject({
      matched: false,
    });
    s.pair.mockResolvedValueOnce({ kind: 'rejected', reason: 'native_unavailable' });
    await expect(s.service.verifyRecompression(a, b, contentDeadline())).rejects.toMatchObject({
      name: 'PhotoNativeUnavailableError',
    });
    await s.service.verifyRecompression(a, b, contentDeadline());
    await s.service.verifyRecompression(a, b, contentDeadline());
    expect(s.pair).toHaveBeenCalledTimes(3);
  });
});

describe('photo album fingerprints', () => {
  const zero = '0'.repeat(64);
  const oneBit = `${'0'.repeat(63)}1`;
  const far = 'f'.repeat(64);
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);

  it('builds the same identity for unordered platform-id multisets', () => {
    expect(createPlatformPhotoAlbumHash(['photo-b', 'photo-a'])).toBe(
      createPlatformPhotoAlbumHash(['photo-a', 'photo-b']),
    );
    expect(createPlatformPhotoAlbumHash(['photo-a', null])).toBeNull();
    expect(createPlatformPhotoAlbumHash(['photo-a', 'photo-a'])).not.toBe(
      createPlatformPhotoAlbumHash(['photo-a']),
    );
  });

  it('builds the same canonical album hash independent of image order', () => {
    const a = fingerprintFixture({ canonicalHash: hashA, pdqHash: zero });
    const b = fingerprintFixture({ canonicalHash: hashB, pdqHash: far });

    expect(createPhotoAlbumFingerprint([a, b]).albumHash).toBe(
      createPhotoAlbumFingerprint([b, a]).albumHash,
    );
  });

  it('matches only a complete unordered multiset', () => {
    const left = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: hashA, pdqHash: zero }),
      fingerprintFixture({ canonicalHash: hashB, pdqHash: far }),
    ]);
    const reordered = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: 'c'.repeat(64), pdqHash: far }),
      fingerprintFixture({ canonicalHash: 'd'.repeat(64), pdqHash: oneBit }),
    ]);
    const partial = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: 'c'.repeat(64), pdqHash: oneBit }),
    ]);

    expect(matchPhotoAlbums(left, reordered, { preset: 'SAME_IMAGE' })).toEqual({
      matched: true,
      strongestDistance: 1,
      usedPerceptualHash: true,
    });
    expect(matchPhotoAlbums(left, partial, { preset: 'SAME_IMAGE' }).matched).toBe(false);
  });

  it('uses canonical equality but blocks perceptual matching below the quality guard', () => {
    const lowQualityLeft = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: hashA, pdqHash: zero, pdqQuality: 49 }),
    ]);
    const lowQualityRight = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: hashB, pdqHash: oneBit, pdqQuality: 49 }),
    ]);
    const canonicalRight = createPhotoAlbumFingerprint([
      fingerprintFixture({ canonicalHash: hashA, pdqHash: far, pdqQuality: 0 }),
    ]);

    expect(
      matchPhotoAlbums(lowQualityLeft, lowQualityRight, { preset: 'MINOR_EDITS' }).matched,
    ).toBe(false);
    expect(matchPhotoAlbums(lowQualityLeft, canonicalRight, { preset: 'MINOR_EDITS' })).toEqual({
      matched: true,
      strongestDistance: 0,
      usedPerceptualHash: false,
    });
  });

  it('calculates the full 256-bit Hamming distance', () => {
    expect(hammingDistanceHex(zero, oneBit)).toBe(1);
    expect(hammingDistanceHex(zero, far)).toBe(256);
  });
});
