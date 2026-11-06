import type { LogicalPhotoAlbum } from './photo-attachment-extractor';
import { PhotoDuplicateAnalysisService } from './photo-duplicate-analysis.service';
import { PhotoDecodeBudget } from './photo-decode-resource';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  PhotoFingerprintRejectedError,
  PhotoFingerprintService,
  type PhotoFingerprint,
} from './photo-fingerprint';
import { PhotoDownloadTimeoutError } from './secure-photo-downloader';
import { PHOTO_RECOMPRESSION_VERSION } from './photo-recompression-version';
import { NativePhotoSandboxClient } from './native-photo-sandbox.client';

const authorizationConfigDigest = 'f'.repeat(64);
const actionConfigDigest = 'e'.repeat(64);

function fingerprint(seed: string): PhotoFingerprint {
  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    canonicalHash: seed.repeat(64).slice(0, 64),
    pdqHash: seed.repeat(64).slice(0, 64),
    pdqQuality: 80,
    decodeCost: { encodedBytes: 100, pixels: 100 },
  };
}

function album(images: LogicalPhotoAlbum['images']): LogicalPhotoAlbum {
  return {
    chatId: 'chat-1',
    messageId: 'message-1',
    senderId: 'user-1',
    createdAtMs: Date.parse('2026-08-05T12:00:00.000Z'),
    caption: '',
    images,
  };
}

function createService(cache: Array<PhotoFingerprint | null>) {
  const downloader = {
    download: jest.fn(async (url: string) => ({
      bytes: Buffer.from(url),
      format: 'jpeg' as const,
    })),
  };
  const generated = fingerprint('c');
  const fingerprintService = {
    createAlbumDecodeBudget: jest.fn(
      () => new PhotoDecodeBudget({ maxEncodedBytes: 1_024, maxPixels: 1_024 }),
    ),
    reserveCachedFingerprint: jest.fn((proof: PhotoFingerprint, budget: PhotoDecodeBudget) =>
      budget.tryReserve(proof.decodeCost!),
    ),
    fingerprint: jest.fn().mockImplementation(async (_bytes, options) => {
      if (!options.albumBudget.tryReserve(generated.decodeCost!)) {
        throw new PhotoFingerprintRejectedError('album_decode_budget_exceeded');
      }
      return generated;
    }),
  };
  const historyStore = {
    getCachedPhotoFingerprints: jest.fn().mockResolvedValue({
      kind: 'available',
      fingerprints: cache,
    }),
    cachePhotoFingerprints: jest.fn().mockResolvedValue(true),
    observeAlbum: jest.fn().mockResolvedValue({
      kind: 'available',
      inserted: true,
      replayed: false,
      classification: 'new',
      clusterId: 'd'.repeat(64),
      matchKind: null,
      matchedDistance: null,
      repeatCount: 0,
      duplicateOfMessageId: null,
      sanctionClusterId: 'e'.repeat(64),
      violationCommitted: false,
      authorization: {
        authorized: true,
        configDigest: authorizationConfigDigest,
      },
    }),
    commitViolation: jest.fn().mockResolvedValue({
      kind: 'available',
      committed: true,
      replayed: false,
      repeatCount: 1,
      sanctionClusterId: 'e'.repeat(64),
      bindingMatches: true,
      actionBinding: {
        intendedAction: 'HIT',
        configDigest: actionConfigDigest,
      },
    }),
  };
  return {
    downloader,
    fingerprintService,
    historyStore,
    generated,
    service: new PhotoDuplicateAnalysisService(
      downloader as never,
      fingerprintService as never,
      historyStore as never,
    ),
  };
}

describe('PhotoDuplicateAnalysisService', () => {
  it('downloads both independent sources again while identical bytes reuse only native computation', async () => {
    const s = createService([]);
    const client = new NativePhotoSandboxClient('/tmp/photo-analysis-content-memo.sock');
    const proof = {
      version: PHOTO_RECOMPRESSION_VERSION,
      originalHash: 'a'.repeat(64),
      currentHash: 'b'.repeat(64),
    };
    const nativePair = jest
      .spyOn(client, 'verifyRecompression')
      .mockImplementation(async (original, current) => ({
        kind: 'recompression',
        matched: true,
        proof,
        decodeCost: { encodedBytes: original.byteLength + current.byteLength, pixels: 200 },
      }));
    const fingerprintService = new PhotoFingerprintService({
      canonicalOnly: true,
      nativeDecoder: client,
    });
    const verifyRecompression = jest.fn<
      ReturnType<PhotoFingerprintService['verifyRecompression']>,
      Parameters<PhotoFingerprintService['verifyRecompression']>
    >((...args) => fingerprintService.verifyRecompression(...args));
    Object.assign(s.fingerprintService, { verifyRecompression });
    const metrics = { recordPhase: jest.fn() };
    const service = new PhotoDuplicateAnalysisService(
      s.downloader as never,
      s.fingerprintService as never,
      s.historyStore as never,
      metrics as never,
    );
    const params = {
      originalUrl: 'https://i.oneme.ru/original',
      currentUrl: 'https://i.oneme.ru/current',
      expectedOriginalHash: proof.originalHash,
      expectedCurrentHash: proof.currentHash,
      deadlineAtMs: Date.now() + 10_000,
    };
    await expect(service.verifyRecompression(params)).resolves.toEqual(proof);
    await expect(service.verifyRecompression(params)).resolves.toEqual(proof);
    expect(s.downloader.download.mock.calls.map(([url]) => url)).toEqual([
      params.originalUrl,
      params.currentUrl,
      params.originalUrl,
      params.currentUrl,
    ]);
    expect(verifyRecompression).toHaveBeenCalledTimes(2);
    expect(nativePair).toHaveBeenCalledTimes(1);
    const phases = metrics.recordPhase.mock.calls.map(([phase]) => phase);
    expect(phases.filter((phase) => phase === 'download')).toHaveLength(4);
    expect(phases.filter((phase) => phase === 'photo_download')).toHaveLength(4);
    expect(phases.filter((phase) => phase === 'recompression_native_roundtrip')).toHaveLength(1);
    expect(phases.filter((phase) => phase === 'recompression_decode_wait')).toHaveLength(1);
    expect(phases.filter((phase) => phase === 'recompression_reuse')).toHaveLength(1);
    expect(phases).not.toContain('native_roundtrip');

    const unavailable = new Error('current source unavailable');
    s.downloader.download
      .mockResolvedValueOnce({ bytes: Buffer.from(params.originalUrl), format: 'jpeg' })
      .mockRejectedValueOnce(unavailable);
    metrics.recordPhase.mockImplementation(() => {
      throw new Error('observer unavailable');
    });
    await expect(service.verifyRecompression(params)).rejects.toBe(unavailable);
    expect(nativePair).toHaveBeenCalledTimes(1);
    expect(metrics.recordPhase.mock.calls.filter(([phase]) => phase === 'download')).toHaveLength(
      6,
    );
  });

  it('requires independent sources, both expected SHA values and a native pair match', async () => {
    const s = createService([]);
    const proof = {
      version: PHOTO_RECOMPRESSION_VERSION,
      originalHash: 'a'.repeat(64),
      currentHash: 'b'.repeat(64),
    };
    const verifyRecompression = jest
      .fn<
        ReturnType<PhotoFingerprintService['verifyRecompression']>,
        Parameters<PhotoFingerprintService['verifyRecompression']>
      >()
      .mockResolvedValue({
        kind: 'recompression',
        matched: true,
        proof,
        decodeCost: { encodedBytes: 2, pixels: 2 },
      });
    Object.assign(s.fingerprintService, { verifyRecompression });
    const params = {
      originalUrl: 'https://i.oneme.ru/original',
      currentUrl: 'https://i.oneme.ru/current',
      expectedOriginalHash: proof.originalHash,
      expectedCurrentHash: proof.currentHash,
      deadlineAtMs: Date.now() + 10_000,
    };
    await expect(s.service.verifyRecompression(params)).resolves.toEqual(proof);
    expect(s.downloader.download.mock.calls.map(([url]) => url)).toEqual([
      params.originalUrl,
      params.currentUrl,
    ]);
    expect(verifyRecompression).toHaveBeenCalledWith(
      Buffer.from(params.originalUrl),
      Buffer.from(params.currentUrl),
      { deadlineAtMs: params.deadlineAtMs, timings: undefined },
    );
    await expect(
      s.service.verifyRecompression({ ...params, expectedCurrentHash: 'c'.repeat(64) }),
    ).resolves.toBeNull();
    verifyRecompression.mockResolvedValue({
      kind: 'recompression',
      matched: false,
      proof,
      decodeCost: { encodedBytes: 2, pixels: 2 },
    });
    await expect(s.service.verifyRecompression(params)).resolves.toBeNull();
  });

  it('refreshes old cached exact evidence only when the caller requires candidate descriptors', async () => {
    const cached = fingerprint('a');
    const s = createService([cached]);
    const source = album([
      { source: 'direct', photoId: 'photo', downloadUrl: 'https://i.oneme.ru/a' },
    ]);
    await s.service.fingerprintAlbum(source, 60);
    expect(s.downloader.download).not.toHaveBeenCalled();
    await s.service.fingerprintAlbum(source, 60, Date.now() + 10_000, true);
    expect(s.downloader.download).toHaveBeenCalledTimes(1);
  });

  it('measures failed downloads without changing the original error or persisting partial proof', async () => {
    const s = createService([]);
    const original = new Error('download unavailable');
    s.downloader.download.mockRejectedValueOnce(original);
    const metrics = {
      recordPhase: jest.fn(() => {
        throw new Error('observer unavailable');
      }),
    };
    const service = new PhotoDuplicateAnalysisService(
      s.downloader as never,
      s.fingerprintService as never,
      s.historyStore as never,
      metrics as never,
    );
    await expect(
      service.fingerprintAlbum(
        album([{ source: 'direct', photoId: 'photo', downloadUrl: 'https://i.oneme.ru/a' }]),
        60,
      ),
    ).rejects.toBe(original);
    expect(metrics.recordPhase).toHaveBeenCalledWith('download', expect.any(Number));
    expect(s.fingerprintService.fingerprint).not.toHaveBeenCalled();
    expect(s.historyStore.cachePhotoFingerprints).not.toHaveBeenCalled();
  });

  it.each(['message', 'chat', 'revision', 'source', 'receipt'] as const)(
    'never reuses a photo-ID proof across a different %s',
    async (change) => {
      const s = createService([]);
      const cache = new Map<string, PhotoFingerprint>();
      s.historyStore.getCachedPhotoFingerprints.mockImplementation(async (ids: string[]) => ({
        kind: 'available',
        fingerprints: ids.map((id) => cache.get(id) ?? null),
      }));
      s.historyStore.cachePhotoFingerprints.mockImplementation(
        async (entries: Array<{ photoId: string; fingerprint: PhotoFingerprint }>) => {
          entries.forEach((entry) => cache.set(entry.photoId, entry.fingerprint));
          return true;
        },
      );
      const first = album([
        { source: 'direct', photoId: 'same-platform-id', downloadUrl: 'https://i.oneme.ru/first' },
      ]);
      await s.service.fingerprintAlbum(first, 3600);
      const next = {
        ...first,
        ...(change === 'receipt' ? { receiptId: 'different-receipt' } : {}),
        ...(change === 'message' ? { messageId: 'message-2' } : {}),
        ...(change === 'chat' ? { chatId: 'chat-2' } : {}),
        ...(change === 'revision' ? { createdAtMs: first.createdAtMs + 1 } : {}),
        images: first.images.map((image) => ({
          ...image,
          ...(change === 'source' ? { downloadUrl: 'https://i.oneme.ru/other' } : {}),
        })),
      };
      s.fingerprintService.fingerprint.mockResolvedValue(fingerprint('d'));
      expect(await s.service.fingerprintAlbum(next, 3600)).toMatchObject({
        kind: 'complete',
        fingerprint: { images: [fingerprint('d')] },
      });
      expect(s.downloader.download).toHaveBeenCalledTimes(2);
      await s.service.fingerprintAlbum(next, 3600);
      expect(s.downloader.download).toHaveBeenCalledTimes(2);
    },
  );

  it.each([true, false])(
    'resumes a verified prefix after a late failure (photo ID: %s)',
    async (withId) => {
      const s = createService([]);
      const proofs = new Map<string, PhotoFingerprint>();
      s.historyStore.getCachedPhotoFingerprints.mockImplementation(async (ids: string[]) => ({
        kind: 'available',
        fingerprints: ids.map((id) => proofs.get(id) ?? null),
      }));
      s.historyStore.cachePhotoFingerprints.mockImplementation(async (entries) => {
        entries.forEach((entry: { photoId: string; fingerprint: PhotoFingerprint }) =>
          proofs.set(entry.photoId, entry.fingerprint),
        );
        return true;
      });
      const images = album(
        ['first', 'second'].map((name) => ({
          source: 'direct' as const,
          photoId: withId ? name : null,
          downloadUrl: `https://i.oneme.ru/${name}`,
        })),
      );
      s.downloader.download
        .mockImplementationOnce(async () => ({ bytes: Buffer.from('first'), format: 'jpeg' }))
        .mockRejectedValueOnce(new Error('transient'));
      await expect(s.service.fingerprintAlbum(images, 3600)).rejects.toThrow('transient');
      expect(s.historyStore.observeAlbum).not.toHaveBeenCalled();
      expect(proofs.size).toBe(1);
      await expect(s.service.fingerprintAlbum(images, 3600)).resolves.toMatchObject({
        kind: 'complete',
      });
      expect(s.downloader.download.mock.calls.map(([url]) => url)).toEqual([
        'https://i.oneme.ru/first',
        'https://i.oneme.ru/second',
        'https://i.oneme.ru/second',
      ]);
      expect(s.fingerprintService.fingerprint).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps successful verification usable when checkpoint writes are unavailable', async () => {
    const s = createService([null]);
    s.historyStore.cachePhotoFingerprints.mockResolvedValue(false);
    await expect(
      s.service.fingerprintAlbum(
        album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
        3600,
      ),
    ).resolves.toMatchObject({ kind: 'complete' });
    expect(s.downloader.download).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled proof lookup and ignores its late proof after computing a cache miss', async () => {
    jest.useFakeTimers();
    try {
      const s = createService([]);
      let resolveLookup!: (lookup: { kind: string; fingerprints: PhotoFingerprint[] }) => void;
      s.historyStore.getCachedPhotoFingerprints.mockImplementation(
        () => new Promise((resolve) => (resolveLookup = resolve)),
      );
      const pending = s.service.fingerprintAlbum(
        album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
        3600,
      );
      await jest.advanceTimersByTimeAsync(251);
      const result = await pending;
      expect(result).toMatchObject({
        kind: 'complete',
        fingerprint: { images: [s.generated] },
      });
      expect(s.downloader.download).toHaveBeenCalledTimes(1);
      expect(s.fingerprintService.fingerprint).toHaveBeenCalledTimes(1);
      resolveLookup({ kind: 'available', fingerprints: [fingerprint('a')] });
      await jest.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({ fingerprint: { images: [s.generated] } });
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats proof-cache lookup failure as a miss', async () => {
    const s = createService([]);
    s.historyStore.getCachedPhotoFingerprints.mockRejectedValue(new Error('cache unavailable'));
    await expect(
      s.service.fingerprintAlbum(
        album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
        3600,
      ),
    ).resolves.toMatchObject({ kind: 'complete', fingerprint: { images: [s.generated] } });
    expect(s.fingerprintService.fingerprint).toHaveBeenCalledTimes(1);
  });

  it.each(['stalled', 'rejected', 'late_rejected'] as const)(
    'keeps verified native work usable with a %s checkpoint write',
    async (failure) => {
      jest.useFakeTimers();
      try {
        const s = createService([null]);
        let rejectWrite!: (reason: Error) => void;
        s.historyStore.cachePhotoFingerprints.mockImplementation(() =>
          failure === 'rejected'
            ? Promise.reject(new Error('cache unavailable'))
            : new Promise((_resolve, reject) => (rejectWrite = reject)),
        );
        const pending = s.service.fingerprintAlbum(
          album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
          3600,
        );
        await jest.advanceTimersByTimeAsync(251);
        await expect(pending).resolves.toMatchObject({ kind: 'complete' });
        if (failure === 'late_rejected') {
          rejectWrite(new Error('late cache failure'));
          await jest.advanceTimersByTimeAsync(0);
        }
        expect(s.downloader.download).toHaveBeenCalledTimes(1);
        expect(s.fingerprintService.fingerprint).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(['read', 'write'] as const)(
    'bounds a stalled proof-cache %s by the remaining attempt deadline',
    async (operation) => {
      jest.useFakeTimers();
      try {
        const s = createService([null]);
        if (operation === 'read') {
          s.historyStore.getCachedPhotoFingerprints.mockImplementation(() => new Promise(() => {}));
        } else {
          s.historyStore.cachePhotoFingerprints.mockImplementation(() => new Promise(() => {}));
        }
        const pending = s.service.fingerprintAlbum(
          album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
          3600,
          Date.now() + 50,
        );
        await jest.advanceTimersByTimeAsync(51);
        await expect(pending).resolves.toEqual({
          kind: 'incomplete',
          reason: 'decode_deadline_exceeded',
        });
        expect(s.fingerprintService.fingerprint).toHaveBeenCalledTimes(
          operation === 'read' ? 0 : 1,
        );
        expect(s.historyStore.observeAlbum).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('performs no cache or source work when the attempt has already expired', async () => {
    const s = createService([null]);
    await expect(
      s.service.fingerprintAlbum(
        album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
        3600,
        Date.now() - 1,
      ),
    ).resolves.toEqual({ kind: 'incomplete', reason: 'decode_deadline_exceeded' });
    expect(s.historyStore.getCachedPhotoFingerprints).not.toHaveBeenCalled();
    expect(s.downloader.download).not.toHaveBeenCalled();
    expect(s.fingerprintService.fingerprint).not.toHaveBeenCalled();
  });

  it.each(['completed', 'timed_out'] as const)(
    'defers a %s download at the attempt deadline without starting native decoding',
    async (outcome) => {
      const s = createService([null]);
      let currentTime = 100;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
      try {
        s.downloader.download.mockImplementation(async () => {
          currentTime = 200;
          if (outcome === 'timed_out') throw new PhotoDownloadTimeoutError();
          return { bytes: Buffer.from('verified'), format: 'jpeg' };
        });
        await expect(
          s.service.fingerprintAlbum(
            album([
              { source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' },
            ]),
            3600,
            200,
          ),
        ).resolves.toEqual({ kind: 'incomplete', reason: 'decode_deadline_exceeded' });
        expect(s.fingerprintService.fingerprint).not.toHaveBeenCalled();
        expect(s.historyStore.cachePhotoFingerprints).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('preserves source timeout errors while attempt time remains', async () => {
    const s = createService([null]);
    const original = new PhotoDownloadTimeoutError();
    s.downloader.download.mockRejectedValue(original);
    await expect(
      s.service.fingerprintAlbum(
        album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
        3600,
        Date.now() + 30_000,
      ),
    ).rejects.toBe(original);
  });

  it.each(['bytes', 'pixels'] as const)(
    'returns a typed rejection when cached proof exceeds the current image %s limit',
    async (limit) => {
      const s = createService([fingerprint('a')]);
      const fingerprintService = new PhotoFingerprintService({
        canonicalOnly: true,
        ...(limit === 'bytes' ? { maxInputBytes: 50 } : { maxInputPixels: 50 }),
      });
      const service = new PhotoDuplicateAnalysisService(
        s.downloader as never,
        fingerprintService,
        s.historyStore as never,
      );
      await expect(
        service.fingerprintAlbum(
          album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
          3600,
        ),
      ).resolves.toEqual({
        kind: 'incomplete',
        reason: limit === 'bytes' ? 'image_byte_limit_exceeded' : 'image_pixel_limit_exceeded',
      });
      expect(s.downloader.download).not.toHaveBeenCalled();
      expect(s.historyStore.observeAlbum).not.toHaveBeenCalled();
    },
  );

  it.each(Array.from({ length: 10 }, (_, index) => index + 1))(
    'resumes in a fresh service after attempt expiry following photo %i of 10',
    async (completedBeforeInterruption) => {
      const proofs = new Map<string, string>();
      const first = createService([]);
      const resumed = createService([]);
      let currentTime = 100;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
      const prepareFirst = first.service.fingerprintAlbum.bind(first.service);
      jest
        .spyOn(first.service, 'fingerprintAlbum')
        .mockImplementation((input, ttl) => prepareFirst(input, ttl, 200));
      let checkpointCount = 0;
      for (const fixture of [first, resumed]) {
        fixture.historyStore.getCachedPhotoFingerprints.mockImplementation(
          async (ids: string[]) => ({
            kind: 'available',
            fingerprints: ids.map((id) => {
              const serialized = proofs.get(id);
              return serialized ? (JSON.parse(serialized) as PhotoFingerprint) : null;
            }),
          }),
        );
        fixture.historyStore.cachePhotoFingerprints.mockImplementation(async (entries) => {
          for (const entry of entries) proofs.set(entry.photoId, JSON.stringify(entry.fingerprint));
          if (fixture === first && ++checkpointCount === completedBeforeInterruption) {
            // FLAG: Expire after persistence, before the next photo or complete-album
            // handoff. The replacement service shares only serialized external proofs.
            currentTime = 200;
          }
          return true;
        });
      }
      const images = Array.from({ length: 10 }, (_, index) => ({
        source: 'direct' as const,
        photoId: `photo-${index}`,
        downloadUrl: `https://i.oneme.ru/photo-${index}`,
      }));
      const resolveActionEligibility = jest.fn().mockResolvedValue(true);
      const input = {
        album: { ...album(images), receiptId: 'exact-receipt' },
        ttlSeconds: 3600,
        scope: 'SAME_AUTHOR' as const,
        preset: 'SAME_IMAGE' as const,
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'] as const,
        resolveActionEligibility,
      };
      try {
        await expect(first.service.analyzeAlbum(input)).resolves.toEqual({
          kind: 'incomplete',
          reason: 'decode_deadline_exceeded',
        });
        expect(proofs.size).toBe(completedBeforeInterruption);
        expect(first.historyStore.observeAlbum).not.toHaveBeenCalled();
        expect(resolveActionEligibility).not.toHaveBeenCalled();

        await expect(resumed.service.analyzeAlbum(input)).resolves.toMatchObject({
          kind: 'observed',
          imageCount: 10,
          actionEligible: true,
        });
        expect(resumed.downloader.download.mock.calls.map(([url]) => url)).toEqual(
          images.slice(completedBeforeInterruption).map((image) => image.downloadUrl),
        );
        expect(first.fingerprintService.fingerprint.mock.calls.length).toBe(
          completedBeforeInterruption,
        );
        expect(resumed.fingerprintService.fingerprint).toHaveBeenCalledTimes(
          10 - completedBeforeInterruption,
        );
        expect(resumed.historyStore.observeAlbum).toHaveBeenCalledTimes(1);
        expect(resolveActionEligibility).toHaveBeenCalledTimes(1);
      } finally {
        now.mockRestore();
      }
    },
  );

  it('persists the first proof before the next-image deadline, without partial observation', async () => {
    const s = createService([null, null]);
    let currentTime = 100;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    s.historyStore.cachePhotoFingerprints.mockImplementation(async () => {
      currentTime = 201;
      return true;
    });
    try {
      await expect(
        s.service.fingerprintAlbum(
          album([
            { source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' },
            { source: 'direct', photoId: 'second', downloadUrl: 'https://i.oneme.ru/second' },
          ]),
          3600,
          200,
        ),
      ).resolves.toEqual({ kind: 'incomplete', reason: 'decode_deadline_exceeded' });
      expect(s.historyStore.cachePhotoFingerprints).toHaveBeenCalledTimes(1);
      expect(s.downloader.download).toHaveBeenCalledTimes(1);
      expect(s.historyStore.observeAlbum).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('charges cached images to the album budget on resume', async () => {
    const expensive = { ...fingerprint('a'), decodeCost: { encodedBytes: 950, pixels: 950 } };
    const s = createService([expensive, null]);
    await expect(
      s.service.fingerprintAlbum(
        album([
          { source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' },
          { source: 'direct', photoId: 'second', downloadUrl: 'https://i.oneme.ru/second' },
        ]),
        3600,
      ),
    ).resolves.toEqual({ kind: 'incomplete', reason: 'album_decode_budget_exceeded' });
    expect(s.historyStore.observeAlbum).not.toHaveBeenCalled();
    expect(s.historyStore.cachePhotoFingerprints).not.toHaveBeenCalled();
  });

  it('recomputes old proofs without resource costs', async () => {
    const old = fingerprint('a');
    delete old.decodeCost;
    const s = createService([old]);
    await s.service.fingerprintAlbum(
      album([{ source: 'direct', photoId: 'first', downloadUrl: 'https://i.oneme.ru/first' }]),
      3600,
    );
    expect(s.downloader.download).toHaveBeenCalledTimes(1);
  });

  it('retains cached positions when another album member has no photo ID', async () => {
    const cached = fingerprint('a');
    const s = createService([null, cached]);
    const result = await s.service.fingerprintAlbum(
      album([
        { source: 'direct', photoId: null, downloadUrl: 'https://i.oneme.ru/new' },
        { source: 'direct', photoId: 'cached', downloadUrl: null },
      ]),
      3600,
    );
    expect(result).toMatchObject({
      kind: 'complete',
      fingerprint: { images: [s.generated, cached] },
    });
    expect(s.historyStore.getCachedPhotoFingerprints).toHaveBeenCalledWith([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(s.downloader.download).toHaveBeenCalledTimes(1);
    expect(s.downloader.download).toHaveBeenCalledWith('https://i.oneme.ru/new');
  });
  it('reuses a message-scoped photo proof without downloading bytes again', async () => {
    const first = fingerprint('a');
    const second = fingerprint('b');
    const { service, downloader, historyStore } = createService([first, second]);
    const resolveActionEligibility = jest.fn().mockResolvedValue(true);

    const result = await service.analyzeAlbum({
      album: album([
        { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        { source: 'direct', photoId: 'photo-2', downloadUrl: 'https://i.oneme.ru/2' },
      ]),
      ttlSeconds: 3_601,
      scope: 'SAME_AUTHOR',
      preset: 'SAME_IMAGE',
      actionEligible: true,
      authorizationConfigDigest,
      allowedViolationMatchKinds: ['canonical_sha256'],
      resolveActionEligibility,
    });

    expect(result).toMatchObject({ kind: 'observed', imageCount: 2, actionEligible: true });
    expect(downloader.download).not.toHaveBeenCalled();
    expect(resolveActionEligibility).toHaveBeenCalledTimes(1);
    expect(historyStore.observeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
        exactMatchKind: 'canonical_sha256',
        allowPerceptualMatch: true,
        perceptualPreset: 'SAME_IMAGE',
        authorization: {
          eligible: true,
          configDigest: authorizationConfigDigest,
          allowedMatchKinds: ['canonical_sha256'],
        },
      }),
    );
  });

  it('downloads only cache misses and stores no URL or token in the cache', async () => {
    const cached = fingerprint('a');
    const { service, downloader, historyStore, generated } = createService([cached, null]);
    const resolveActionEligibility = jest.fn().mockResolvedValue(true);

    await service.analyzeAlbum({
      album: album([
        { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        { source: 'direct', photoId: 'photo-2', downloadUrl: 'https://i.oneme.ru/2?token=secret' },
      ]),
      ttlSeconds: 7_201,
      scope: 'CHAT',
      preset: 'MINOR_EDITS',
      actionEligible: false,
      authorizationConfigDigest,
      allowedViolationMatchKinds: ['canonical_sha256'],
      resolveActionEligibility,
    });

    expect(downloader.download).toHaveBeenCalledTimes(1);
    expect(historyStore.cachePhotoFingerprints).toHaveBeenCalledWith(
      [{ photoId: expect.stringMatching(/^[a-f0-9]{64}$/), fingerprint: generated }],
      7_201,
    );
    expect(JSON.stringify(historyStore.cachePhotoFingerprints.mock.calls[0]?.[0])).not.toContain(
      'secret',
    );
    expect(resolveActionEligibility).toHaveBeenCalledTimes(1);
    expect(historyStore.cachePhotoFingerprints.mock.invocationCallOrder[0]!).toBeLessThan(
      resolveActionEligibility.mock.invocationCallOrder[0]!,
    );
    expect(resolveActionEligibility.mock.invocationCallOrder[0]!).toBeLessThan(
      historyStore.observeAlbum.mock.invocationCallOrder[0]!,
    );
  });

  it('shares one bounded decode budget across all cache misses in an album', async () => {
    const { service, fingerprintService } = createService([null, null]);

    await service.analyzeAlbum({
      album: album([
        { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        { source: 'direct', photoId: 'photo-2', downloadUrl: 'https://i.oneme.ru/2' },
      ]),
      ttlSeconds: 7_201,
      scope: 'CHAT',
      preset: 'MINOR_EDITS',
      actionEligible: false,
      authorizationConfigDigest,
      allowedViolationMatchKinds: ['canonical_sha256'],
      resolveActionEligibility: jest.fn().mockResolvedValue(true),
    });

    expect(fingerprintService.createAlbumDecodeBudget).toHaveBeenCalledTimes(1);
    expect(fingerprintService.fingerprint).toHaveBeenCalledTimes(2);
    expect(fingerprintService.fingerprint.mock.calls[0]?.[1]?.albumBudget).toBe(
      fingerprintService.fingerprint.mock.calls[1]?.[1]?.albumBudget,
    );
    expect(fingerprintService.fingerprint).toHaveBeenNthCalledWith(
      1,
      expect.any(Buffer),
      expect.objectContaining({ expectedFormat: 'jpeg' }),
    );
  });

  it('fails open without observing or caching a rejected image container', async () => {
    const { service, fingerprintService, historyStore } = createService([null]);
    fingerprintService.fingerprint.mockRejectedValueOnce(
      new PhotoFingerprintRejectedError('unsupported_multi_frame'),
    );

    await expect(
      service.analyzeAlbum({
        album: album([
          { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/animated' },
        ]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility: jest.fn().mockResolvedValue(true),
      }),
    ).resolves.toEqual({ kind: 'incomplete', reason: 'unsupported_multi_frame' });
    expect(historyStore.cachePhotoFingerprints).not.toHaveBeenCalled();
    expect(historyStore.observeAlbum).not.toHaveBeenCalled();
  });

  it('fails open when an uncached album member has no download URL', async () => {
    const { service, historyStore } = createService([null]);

    await expect(
      service.analyzeAlbum({
        album: album([{ source: 'direct', photoId: 'photo-1', downloadUrl: null }]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility: jest.fn().mockResolvedValue(true),
      }),
    ).resolves.toEqual({ kind: 'incomplete', reason: 'missing_download_url' });
    expect(historyStore.observeAlbum).not.toHaveBeenCalled();
  });

  it('downgrades a late action latch before observing the violation counter', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    const resolveActionEligibility = jest.fn().mockResolvedValue(false);

    const result = await service.analyzeAlbum({
      album: album([{ source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' }]),
      ttlSeconds: 3_601,
      scope: 'SAME_AUTHOR',
      preset: 'SAME_IMAGE',
      actionEligible: true,
      authorizationConfigDigest,
      allowedViolationMatchKinds: ['canonical_sha256'],
      resolveActionEligibility,
    });

    expect(resolveActionEligibility).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'observed', actionEligible: false });
    expect(historyStore.observeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ eligible: false }),
      }),
    );
  });

  it('keeps a disallowed PDQ observation non-actionable after matching', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    historyStore.observeAlbum.mockResolvedValueOnce({
      kind: 'available',
      inserted: true,
      replayed: false,
      classification: 'duplicate',
      clusterId: 'd'.repeat(64),
      matchKind: 'pdq',
      matchedDistance: 4,
      repeatCount: 0,
      duplicateOfMessageId: 'message-0',
      sanctionClusterId: 'e'.repeat(64),
      violationCommitted: false,
      authorization: {
        authorized: false,
        configDigest: authorizationConfigDigest,
      },
    });

    await expect(
      service.analyzeAlbum({
        album: album([
          { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        ]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility: jest.fn().mockResolvedValue(true),
      }),
    ).resolves.toMatchObject({ kind: 'observed', actionEligible: false });
    expect(historyStore.observeAlbum).toHaveBeenCalledWith(
      expect.not.objectContaining({ commitViolation: expect.anything() }),
    );
  });

  it('keeps an authorized replay non-actionable when its first-write config digest differs', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    historyStore.observeAlbum.mockResolvedValueOnce({
      kind: 'available',
      inserted: false,
      replayed: true,
      classification: 'duplicate',
      clusterId: 'd'.repeat(64),
      matchKind: 'canonical_sha256',
      matchedDistance: 0,
      repeatCount: 1,
      duplicateOfMessageId: 'message-0',
      sanctionClusterId: 'e'.repeat(64),
      violationCommitted: false,
      authorization: {
        authorized: true,
        configDigest: '1'.repeat(64),
      },
    });

    await expect(
      service.analyzeAlbum({
        album: album([
          { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        ]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility: jest.fn().mockResolvedValue(true),
      }),
    ).resolves.toMatchObject({ kind: 'observed', actionEligible: false });
  });

  it('delegates the guarded violation commit with the exact observed identity', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    const logicalAlbum = album([
      { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
    ]);

    await expect(
      service.commitViolation({
        album: logicalAlbum,
        albumHash: 'a'.repeat(64),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        observationClusterId: 'd'.repeat(64),
        matchKind: 'canonical_sha256',
        expectedRepeatCount: 1,
        allowedMatchKinds: ['canonical_sha256'],
        authorizationConfigDigest,
        actionBinding: {
          intendedAction: 'HIT',
          configDigest: actionConfigDigest,
        },
      }),
    ).resolves.toMatchObject({ kind: 'available', committed: true });
    expect(historyStore.commitViolation).toHaveBeenCalledWith({
      chatId: logicalAlbum.chatId,
      senderId: logicalAlbum.senderId,
      messageId: logicalAlbum.messageId,
      ttlSeconds: 3_601,
      scope: 'SAME_AUTHOR',
      fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      albumHash: 'a'.repeat(64),
      perceptualPreset: 'SAME_IMAGE',
      observationClusterId: 'd'.repeat(64),
      matchKind: 'canonical_sha256',
      expectedRepeatCount: 1,
      allowedMatchKinds: ['canonical_sha256'],
      authorizationConfigDigest,
      actionBinding: {
        intendedAction: 'HIT',
        configDigest: actionConfigDigest,
      },
    });
  });

  it('does not observe when action eligibility resolution rejects', async () => {
    const cached = fingerprint('a');
    const { service, historyStore } = createService([cached]);
    const resolveActionEligibility = jest.fn().mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.analyzeAlbum({
        album: album([
          { source: 'direct', photoId: 'photo-1', downloadUrl: 'https://i.oneme.ru/1' },
        ]),
        ttlSeconds: 3_601,
        scope: 'SAME_AUTHOR',
        preset: 'SAME_IMAGE',
        actionEligible: true,
        authorizationConfigDigest,
        allowedViolationMatchKinds: ['canonical_sha256'],
        resolveActionEligibility,
      }),
    ).rejects.toThrow('redis unavailable');

    expect(historyStore.observeAlbum).not.toHaveBeenCalled();
  });
});
