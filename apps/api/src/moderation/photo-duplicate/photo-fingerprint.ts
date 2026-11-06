import {
  measureDuplicatePhase,
  recordDuplicatePhase,
  type DuplicatePhaseRecorder,
} from '../message-duplicate/message-duplicate-phase-timing';
import type { NativePhotoSandboxClient } from './native-photo-sandbox.client';
import { createHash } from 'node:crypto';
import type { OnModuleInit } from '@nestjs/common';
import { PDQ } from 'pdq-wasm';
import sharp from 'sharp';
import {
  recompressionCandidateHash,
  verifyNativePhotoRecompression,
  PhotoRecompressionRejectedError,
  type PhotoRecompressionResult,
} from './photo-recompression';
import {
  PhotoDecodeBudget,
  PhotoDecodeDeadlineError,
  type PhotoDecodeCost,
  PhotoDecodePipelineCapacityError,
  PhotoDecodePipelineGate,
} from './photo-decode-resource';

import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint-version';
import { PHOTO_RECOMPRESSION_VERSION } from './photo-recompression-version';
import { PhotoNativeResultMemo } from './photo-native-result-memo';
export { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint-version';
export const PHOTO_PLATFORM_ID_ALGORITHM_VERSION = 'max-photo-id-album-v1';
export const PHOTO_PD_DEFAULT_MIN_QUALITY = 50;
export const PHOTO_PD_SAME_IMAGE_MAX_DISTANCE = 12;
export const PHOTO_PD_MINOR_EDITS_MAX_DISTANCE = 31;

const NORMALIZED_IMAGE_SIZE = 512;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_ALBUM_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_ALBUM_INPUT_PIXELS = 160_000_000;
const DEFAULT_MAX_CONCURRENT_PIPELINES = 1;
const DEFAULT_MAX_QUEUED_PIPELINES = 8;
const ALBUM_BUDGET_MULTIPLIER = 2;
const MAX_RECOMPRESSION_PAIR_PIXELS = 8_000_000;

export type SupportedPhotoFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'heif' | 'tiff';

export type PhotoFingerprintRejectionReason =
  | 'unsupported_image'
  | 'unsupported_multi_frame'
  | 'image_byte_limit_exceeded'
  | 'image_pixel_limit_exceeded'
  | 'album_decode_budget_exceeded'
  | 'decode_capacity_exceeded'
  | 'decode_deadline_exceeded';

export class PhotoFingerprintRejectedError extends Error {
  constructor(
    readonly reason: PhotoFingerprintRejectionReason,
    options?: { cause?: unknown },
  ) {
    super(`Photo fingerprint rejected: ${reason}`, options);
    this.name = 'PhotoFingerprintRejectedError';
  }
}

export class PhotoNativeUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Photo native decoder unavailable', options);
    this.name = 'PhotoNativeUnavailableError';
  }
}

export type PhotoFingerprint = {
  algorithmVersion: typeof PHOTO_FINGERPRINT_ALGORITHM_VERSION;
  canonicalHash: string;
  pdqHash: string;
  pdqQuality: number;
  recompressionHash?: string;
  decodeCost?: PhotoDecodeCost;
};

export type PhotoAlbumFingerprint = {
  algorithmVersion: typeof PHOTO_FINGERPRINT_ALGORITHM_VERSION;
  albumHash: string;
  images: PhotoFingerprint[];
};

export type PhotoMatchPreset = 'SAME_IMAGE' | 'MINOR_EDITS';

export type PhotoAlbumMatch = {
  matched: boolean;
  strongestDistance: number | null;
  usedPerceptualHash: boolean;
};

let pdqInitialization: Promise<void> | null = null;

export async function initializePhotoFingerprintRuntime(): Promise<void> {
  // In CommonJS Node, pdq-wasm resolves both pdq.js and pdq.wasm from its installed package.
  // No URL is supplied, so the browser-only CDN branch cannot be selected.
  if (!pdqInitialization) {
    const initialization = PDQ.init().catch((error: unknown) => {
      if (pdqInitialization === initialization) {
        pdqInitialization = null;
      }
      throw error;
    });
    pdqInitialization = initialization;
  }
  await pdqInitialization;
}

export class PhotoFingerprintService implements OnModuleInit {
  private readonly maxInputBytes: number;
  private readonly maxInputPixels: number;
  private readonly maxAlbumInputBytes: number;
  private readonly maxAlbumInputPixels: number;
  private readonly decodeGate: PhotoDecodePipelineGate;
  private readonly canonicalOnly: boolean;
  private readonly nativeDecoder?: NativePhotoSandboxClient;
  private readonly nativeFingerprintMemo = new PhotoNativeResultMemo(cloneFingerprint);
  private readonly nativeRecompressionMemo = new PhotoNativeResultMemo(cloneRecompression);

  constructor(
    limits: {
      maxInputBytes?: number;
      maxInputPixels?: number;
      maxAlbumInputBytes?: number;
      maxAlbumInputPixels?: number;
      maxConcurrentPipelines?: number;
      maxQueuedPipelines?: number;
      canonicalOnly?: boolean;
      nativeDecoder?: NativePhotoSandboxClient;
    } = {},
  ) {
    this.canonicalOnly = limits.canonicalOnly ?? false;
    this.nativeDecoder = limits.nativeDecoder;
    if (this.nativeDecoder && !this.canonicalOnly)
      throw new Error('Native photo sandbox only supports exact fingerprints');
    this.maxInputBytes = normalizePositiveInteger(
      limits.maxInputBytes,
      MAX_INPUT_BYTES,
      'maxInputBytes',
    );
    this.maxInputPixels = normalizePositiveInteger(
      limits.maxInputPixels,
      MAX_INPUT_PIXELS,
      'maxInputPixels',
    );
    this.maxAlbumInputBytes = normalizeAlbumLimit(
      limits.maxAlbumInputBytes,
      this.maxInputBytes,
      MAX_ALBUM_INPUT_BYTES,
      'maxAlbumInputBytes',
    );
    this.maxAlbumInputPixels = normalizeAlbumLimit(
      limits.maxAlbumInputPixels,
      this.maxInputPixels,
      MAX_ALBUM_INPUT_PIXELS,
      'maxAlbumInputPixels',
    );
    this.decodeGate = new PhotoDecodePipelineGate(
      normalizePositiveInteger(
        limits.maxConcurrentPipelines,
        DEFAULT_MAX_CONCURRENT_PIPELINES,
        'maxConcurrentPipelines',
      ),
      normalizePositiveInteger(
        limits.maxQueuedPipelines,
        DEFAULT_MAX_QUEUED_PIPELINES,
        'maxQueuedPipelines',
      ),
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.nativeDecoder) await this.nativeDecoder.probe();
    if (!this.canonicalOnly) await initializePhotoFingerprintRuntime();
  }

  createAlbumDecodeBudget(): PhotoDecodeBudget {
    return new PhotoDecodeBudget({
      maxEncodedBytes: this.maxAlbumInputBytes,
      maxPixels: this.maxAlbumInputPixels,
    });
  }

  reserveCachedFingerprint(fingerprint: PhotoFingerprint, budget: PhotoDecodeBudget): boolean {
    const cost = fingerprint.decodeCost;
    if (!cost) throw new PhotoFingerprintRejectedError('unsupported_image');
    if (cost.encodedBytes > this.maxInputBytes)
      throw new PhotoFingerprintRejectedError('image_byte_limit_exceeded');
    if (cost.pixels > this.maxInputPixels)
      throw new PhotoFingerprintRejectedError('image_pixel_limit_exceeded');
    return budget.tryReserve(cost);
  }

  async fingerprint(
    encodedImage: Uint8Array,
    options: {
      albumBudget?: PhotoDecodeBudget;
      expectedFormat?: SupportedPhotoFormat;
      deadlineAtMs?: number;
      timings?: DuplicatePhaseRecorder;
    } = {},
  ): Promise<PhotoFingerprint> {
    if (encodedImage.byteLength === 0 || encodedImage.byteLength > this.maxInputBytes) {
      throw new PhotoFingerprintRejectedError('image_byte_limit_exceeded');
    }

    let waitingSince = performance.now();
    let enteredSlot = false;
    let requestedSlot = false;
    try {
      if (this.nativeDecoder) {
        requirePhotoDeadline(options.deadlineAtMs);
        const key = this.nativeFingerprintKey(encodedImage, options.expectedFormat);
        requirePhotoDeadline(options.deadlineAtMs);
        const cached = this.cachedNativeFingerprint(key, encodedImage.byteLength, options);
        if (cached) return cached;
      }
      requestedSlot = true;
      waitingSince = performance.now();
      return await this.decodeGate.run(async () => {
        enteredSlot = true;
        recordDuplicatePhase(options.timings, 'decode_wait', performance.now() - waitingSince);
        if (!this.nativeDecoder)
          return measureDuplicatePhase(options.timings, 'local_fingerprint', () =>
            this.fingerprintWithinSlot(encodedImage, options),
          );
        // FLAG: Admission bounds queued memory before copying. Hash and decode the same
        // private snapshot, then recheck the memo; mutable caller bytes never name a proof.
        const nativeInput = Buffer.from(encodedImage);
        if (!nativeInput.length || nativeInput.length > this.maxInputBytes)
          throw new PhotoFingerprintRejectedError('image_byte_limit_exceeded');
        const key = this.nativeFingerprintKey(nativeInput, options.expectedFormat);
        requirePhotoDeadline(options.deadlineAtMs);
        const cached = this.cachedNativeFingerprint(key, nativeInput.byteLength, options);
        if (cached) return cached;
        const usage = options.albumBudget?.usage();
        const remainingEncodedBytes = usage
          ? usage.maxEncodedBytes - usage.encodedBytes
          : this.maxInputBytes;
        const remainingPixels = usage ? usage.maxPixels - usage.pixels : this.maxInputPixels;
        if (remainingEncodedBytes < nativeInput.byteLength || remainingPixels <= 0)
          throw new PhotoFingerprintRejectedError('album_decode_budget_exceeded');
        // FLAG: This measures IPC, process startup, decoding and reply together, not CPU decode.
        const result = await measureDuplicatePhase(options.timings, 'native_roundtrip', () =>
          this.nativeDecoder!.fingerprint(nativeInput, {
            deadlineAtMs: options.deadlineAtMs ?? Date.now() + 30_000,
            maxInputBytes: this.maxInputBytes,
            maxInputPixels: this.maxInputPixels,
            remainingEncodedBytes,
            remainingPixels,
            expectedFormat: options.expectedFormat,
          }),
        ).catch((cause: unknown) => {
          throw new PhotoNativeUnavailableError({ cause });
        });
        if (result.kind === 'rejected') {
          if (result.reason === 'native_unavailable') throw new PhotoNativeUnavailableError();
          throw new PhotoFingerprintRejectedError(result.reason);
        }
        requirePhotoDeadline(options.deadlineAtMs);
        this.validateNativeFingerprint(result.fingerprint, nativeInput.byteLength);
        if (
          options.albumBudget &&
          !this.reserveCachedFingerprint(result.fingerprint, options.albumBudget)
        )
          throw new PhotoFingerprintRejectedError('album_decode_budget_exceeded');
        this.nativeFingerprintMemo.set(key, result.fingerprint);
        return cloneFingerprint(result.fingerprint);
      }, options.deadlineAtMs);
    } catch (error: unknown) {
      if (error instanceof PhotoDecodeDeadlineError) {
        throw new PhotoFingerprintRejectedError('decode_deadline_exceeded', { cause: error });
      }
      if (error instanceof PhotoDecodePipelineCapacityError) {
        throw new PhotoFingerprintRejectedError('decode_capacity_exceeded', { cause: error });
      }
      throw error;
    } finally {
      if (requestedSlot && !enteredSlot)
        recordDuplicatePhase(options.timings, 'decode_wait', performance.now() - waitingSince);
    }
  }

  async verifyRecompression(
    original: Uint8Array,
    current: Uint8Array,
    options: { deadlineAtMs: number; timings?: DuplicatePhaseRecorder },
  ): Promise<PhotoRecompressionResult> {
    const request = {
      deadlineAtMs: options.deadlineAtMs,
      maxInputBytes: this.maxInputBytes,
      maxInputPixels: this.maxInputPixels,
      remainingEncodedBytes: this.maxInputBytes,
      remainingPixels: this.maxInputPixels,
    };
    let waitingSince = performance.now();
    let requestedSlot = false;
    let enteredSlot = false;
    try {
      if (this.nativeDecoder) {
        requirePhotoDeadline(request.deadlineAtMs);
        this.validateNativePairBytes(original, current);
        const key = nativePairKey(original, current);
        requirePhotoDeadline(request.deadlineAtMs);
        const cacheStarted = performance.now();
        const cached = this.cachedNativeRecompression(
          key,
          original.byteLength + current.byteLength,
          request.deadlineAtMs,
        );
        if (cached) {
          recordDuplicatePhase(
            options.timings,
            'recompression_reuse',
            performance.now() - cacheStarted,
          );
          return cached;
        }
      }
      requestedSlot = true;
      waitingSince = performance.now();
      return await this.decodeGate.run(async () => {
        enteredSlot = true;
        recordDuplicatePhase(
          options.timings,
          'recompression_decode_wait',
          performance.now() - waitingSince,
        );
        if (!this.nativeDecoder)
          return measureDuplicatePhase(options.timings, 'local_recompression', () =>
            verifyNativePhotoRecompression(original, current, request),
          );
        // FLAG: A memo hit requires independently supplied bytes, never a URL, receipt,
        // candidate hash or authorization. Rehash both snapshots after bounded slot admission.
        const nativeOriginal = Buffer.from(original);
        const nativeCurrent = Buffer.from(current);
        this.validateNativePairBytes(nativeOriginal, nativeCurrent);
        const key = nativePairKey(nativeOriginal, nativeCurrent);
        requirePhotoDeadline(request.deadlineAtMs);
        const cacheStarted = performance.now();
        const cached = this.cachedNativeRecompression(
          key,
          nativeOriginal.byteLength + nativeCurrent.byteLength,
          request.deadlineAtMs,
        );
        if (cached) {
          recordDuplicatePhase(
            options.timings,
            'recompression_reuse',
            performance.now() - cacheStarted,
          );
          return cached;
        }
        const nativeStarted = performance.now();
        const result = await this.nativeDecoder
          .verifyRecompression(nativeOriginal, nativeCurrent, request)
          .catch((cause: unknown) => {
            throw new PhotoNativeUnavailableError({ cause });
          })
          .finally(() => {
            recordDuplicatePhase(
              options.timings,
              'recompression_native_roundtrip',
              performance.now() - nativeStarted,
            );
          });
        if (result.kind === 'rejected') {
          if (result.reason === 'native_unavailable') throw new PhotoNativeUnavailableError();
          throw new PhotoFingerprintRejectedError(result.reason);
        }
        requirePhotoDeadline(request.deadlineAtMs);
        this.validateNativeRecompression(
          result,
          nativeOriginal.byteLength + nativeCurrent.byteLength,
        );
        if (result.matched) this.nativeRecompressionMemo.set(key, result);
        return cloneRecompression(result);
      }, options.deadlineAtMs);
    } catch (error) {
      if (error instanceof PhotoRecompressionRejectedError)
        throw new PhotoFingerprintRejectedError(error.reason, { cause: error });
      if (error instanceof PhotoDecodeDeadlineError)
        throw new PhotoFingerprintRejectedError('decode_deadline_exceeded', { cause: error });
      if (error instanceof PhotoDecodePipelineCapacityError)
        throw new PhotoFingerprintRejectedError('decode_capacity_exceeded', { cause: error });
      throw error;
    } finally {
      if (requestedSlot && !enteredSlot)
        recordDuplicatePhase(
          options.timings,
          'recompression_decode_wait',
          performance.now() - waitingSince,
        );
    }
  }

  private nativeFingerprintKey(bytes: Uint8Array, expectedFormat?: SupportedPhotoFormat): string {
    return JSON.stringify([
      PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      this.canonicalOnly,
      expectedFormat ?? null,
      encodedPhotoHash(bytes),
    ]);
  }

  private cachedNativeFingerprint(
    key: string,
    encodedBytes: number,
    options: { albumBudget?: PhotoDecodeBudget; deadlineAtMs?: number },
  ): PhotoFingerprint | undefined {
    const cached = this.nativeFingerprintMemo.get(key);
    if (!cached) return undefined;
    requirePhotoDeadline(options.deadlineAtMs);
    this.validateNativeFingerprint(cached, encodedBytes);
    if (options.albumBudget && !this.reserveCachedFingerprint(cached, options.albumBudget))
      throw new PhotoFingerprintRejectedError('album_decode_budget_exceeded');
    return cached;
  }

  private cachedNativeRecompression(
    key: string,
    encodedBytes: number,
    deadlineAtMs: number,
  ): PhotoRecompressionResult | undefined {
    const cached = this.nativeRecompressionMemo.get(key);
    if (!cached) return undefined;
    requirePhotoDeadline(deadlineAtMs);
    this.validateNativeRecompression(cached, encodedBytes);
    return cached;
  }

  private validateNativePairBytes(original: Uint8Array, current: Uint8Array): void {
    if (
      !original.byteLength ||
      !current.byteLength ||
      original.byteLength + current.byteLength > this.maxInputBytes
    )
      throw new PhotoFingerprintRejectedError('image_byte_limit_exceeded');
  }

  private validateNativeFingerprint(fingerprint: PhotoFingerprint, encodedBytes: number): void {
    if (
      fingerprint.algorithmVersion !== PHOTO_FINGERPRINT_ALGORITHM_VERSION ||
      !validNativeCost(fingerprint.decodeCost, encodedBytes, this.maxInputPixels)
    )
      throw new PhotoNativeUnavailableError();
  }

  private validateNativeRecompression(
    result: PhotoRecompressionResult,
    encodedBytes: number,
  ): void {
    if (
      result.proof.version !== PHOTO_RECOMPRESSION_VERSION ||
      !validNativeCost(
        result.decodeCost,
        encodedBytes,
        Math.min(this.maxInputPixels, MAX_RECOMPRESSION_PAIR_PIXELS),
      )
    )
      throw new PhotoNativeUnavailableError();
  }

  private async fingerprintWithinSlot(
    encodedImage: Uint8Array,
    options: {
      albumBudget?: PhotoDecodeBudget;
      expectedFormat?: SupportedPhotoFormat;
    },
  ): Promise<PhotoFingerprint> {
    const input = Buffer.from(
      encodedImage.buffer,
      encodedImage.byteOffset,
      encodedImage.byteLength,
    );
    const image = sharp(input, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: this.maxInputPixels,
      sequentialRead: true,
    });
    let metadata: Awaited<ReturnType<typeof image.metadata>>;
    try {
      metadata = await image.metadata();
    } catch (error: unknown) {
      // FLAG: Sharp emits a fixed pixel-limit failure before returning metadata. Only
      // this bounded classification crosses IPC/metrics; native error text stays private.
      if (error instanceof Error && error.message.toLowerCase().includes('pixel limit'))
        throw new PhotoFingerprintRejectedError('image_pixel_limit_exceeded', { cause: error });
      throw new PhotoFingerprintRejectedError('unsupported_image', { cause: error });
    }

    if (
      !isSupportedPhotoFormat(metadata.format) ||
      metadata.depth !== 'uchar' ||
      (options.expectedFormat && !formatsAreCompatible(options.expectedFormat, metadata.format))
    ) {
      throw new PhotoFingerprintRejectedError('unsupported_image');
    }
    const pages = metadata.pages ?? 1;
    if (
      !Number.isSafeInteger(pages) ||
      pages !== 1 ||
      (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height)
    ) {
      throw new PhotoFingerprintRejectedError('unsupported_multi_frame');
    }

    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) {
      throw new PhotoFingerprintRejectedError('unsupported_image');
    }
    const pixelCount = width * height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > this.maxInputPixels) {
      throw new PhotoFingerprintRejectedError('image_pixel_limit_exceeded');
    }
    if (
      options.albumBudget &&
      !options.albumBudget.tryReserve({
        encodedBytes: encodedImage.byteLength,
        pixels: pixelCount,
      })
    ) {
      throw new PhotoFingerprintRejectedError('album_decode_budget_exceeded');
    }

    // FLAG: Thumbnail resizing/white flattening erase real differences. Exact authority needs
    // native dimensions and alpha; reject higher bit depths above instead of quantizing them.
    const canonicalHash = await hashExactPhotoImage(image.clone());
    const recompressionHash = await recompressionCandidateHash(image);

    // FLAG: Production never initializes PDQ. The separate small candidate hash locates a
    // pair for full native verification; it never changes canonical equality or grants actions.
    let pdqHash = '0'.repeat(64);
    let pdqQuality = 0;
    if (!this.canonicalOnly) {
      const { data, info } = await normalizePhotoImage(image);
      if (
        info.width !== NORMALIZED_IMAGE_SIZE ||
        info.height !== NORMALIZED_IMAGE_SIZE ||
        info.channels !== 3
      ) {
        throw new Error('Photo normalization returned an unexpected pixel layout');
      }
      await initializePhotoFingerprintRuntime();
      const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const pdq = PDQ.hash({ data: pixels, width: info.width, height: info.height, channels: 3 });
      pdqHash = PDQ.toHex(pdq.hash).toLowerCase();
      pdqQuality = pdq.quality;
      if (!/^[0-9a-f]{64}$/.test(pdqHash)) throw new Error('PDQ returned an invalid fingerprint');
    }

    return {
      algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      canonicalHash,
      recompressionHash,
      pdqHash,
      pdqQuality,
      decodeCost: { encodedBytes: encodedImage.byteLength, pixels: pixelCount },
    };
  }
}

function requirePhotoDeadline(deadlineAtMs: number | undefined): void {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs)
    throw new PhotoDecodeDeadlineError();
}

function encodedPhotoHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function nativePairKey(original: Uint8Array, current: Uint8Array): string {
  // FLAG: Recompression is directional; swapping the ordered encoded hashes changes the key.
  return `${PHOTO_FINGERPRINT_ALGORITHM_VERSION}\0${PHOTO_RECOMPRESSION_VERSION}\0${encodedPhotoHash(original)}\0${encodedPhotoHash(current)}`;
}

function validNativeCost(
  cost: PhotoDecodeCost | undefined,
  encodedBytes: number,
  maxPixels: number,
): boolean {
  return (
    cost !== undefined &&
    cost.encodedBytes === encodedBytes &&
    Number.isSafeInteger(cost.pixels) &&
    cost.pixels > 0 &&
    cost.pixels <= maxPixels
  );
}

function cloneFingerprint(fingerprint: PhotoFingerprint): PhotoFingerprint {
  return {
    ...fingerprint,
    decodeCost: fingerprint.decodeCost ? { ...fingerprint.decodeCost } : undefined,
  };
}

function cloneRecompression(result: PhotoRecompressionResult): PhotoRecompressionResult {
  return { ...result, proof: { ...result.proof }, decodeCost: { ...result.decodeCost } };
}

async function hashExactPhotoImage(image: ReturnType<typeof sharp>): Promise<string> {
  try {
    const { data, info } = await image
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error('Unexpected exact photo pixel layout');
    return createHash('sha256')
      .update(`${PHOTO_FINGERPRINT_ALGORITHM_VERSION}\0${info.width}x${info.height}x4\0`)
      .update(data)
      .digest('hex');
  } catch (error: unknown) {
    throw new PhotoFingerprintRejectedError('unsupported_image', { cause: error });
  }
}

function isSupportedPhotoFormat(value: string): value is SupportedPhotoFormat {
  return ['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(value);
}

async function normalizePhotoImage(image: ReturnType<typeof sharp>) {
  try {
    return await image
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .toColourspace('srgb')
      .removeAlpha()
      .resize({
        width: NORMALIZED_IMAGE_SIZE,
        height: NORMALIZED_IMAGE_SIZE,
        fit: 'contain',
        position: 'centre',
        background: { r: 255, g: 255, b: 255 },
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error: unknown) {
    throw new PhotoFingerprintRejectedError('unsupported_image', { cause: error });
  }
}

function formatsAreCompatible(expected: SupportedPhotoFormat, decoded: string): boolean {
  return (
    expected === decoded || ((expected === 'avif' || expected === 'heif') && decoded === 'heif')
  );
}

function normalizeAlbumLimit(
  value: number | undefined,
  perImageLimit: number,
  absoluteLimit: number,
  field: string,
): number {
  const derivedLimit =
    perImageLimit > Math.floor(absoluteLimit / ALBUM_BUDGET_MULTIPLIER)
      ? absoluteLimit
      : perImageLimit * ALBUM_BUDGET_MULTIPLIER;
  return Math.min(normalizePositiveInteger(value, derivedLimit, field), absoluteLimit);
}

export function createPhotoAlbumFingerprint(
  images: readonly PhotoFingerprint[],
): PhotoAlbumFingerprint {
  if (images.length === 0) {
    throw new Error('A photo album fingerprint requires at least one image');
  }
  if (images.some((image) => image.algorithmVersion !== PHOTO_FINGERPRINT_ALGORITHM_VERSION)) {
    throw new Error('Photo fingerprint algorithm versions must match');
  }

  const normalizedImages = images.map((image) => ({
    ...image,
    canonicalHash: validateHexHash(image.canonicalHash),
    pdqHash: validateHexHash(image.pdqHash),
    pdqQuality: normalizeBoundedInteger(image.pdqQuality, 0, 0, 100, 'pdqQuality'),
  }));
  const canonicalHashes = normalizedImages.map((image) => image.canonicalHash).sort();
  const albumHash = createHash('sha256')
    .update(PHOTO_FINGERPRINT_ALGORITHM_VERSION)
    .update('\0album\0')
    .update(String(canonicalHashes.length))
    .update('\0')
    .update(canonicalHashes.join('\n'))
    .digest('hex');

  return {
    algorithmVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
    albumHash,
    images: normalizedImages,
  };
}

export function createPlatformPhotoAlbumHash(
  photoIds: readonly (string | null | undefined)[],
): string | null {
  if (photoIds.length === 0) {
    return null;
  }
  const normalized = photoIds.map((photoId) => photoId?.trim() ?? '');
  if (normalized.some((photoId) => photoId.length === 0)) {
    return null;
  }

  return createHash('sha256')
    .update(PHOTO_PLATFORM_ID_ALGORITHM_VERSION)
    .update('\0')
    .update(String(normalized.length))
    .update('\0')
    .update(normalized.sort().join('\n'))
    .digest('hex');
}

export function matchPhotoAlbums(
  left: PhotoAlbumFingerprint,
  right: PhotoAlbumFingerprint,
  options: {
    preset: PhotoMatchPreset;
    minPdqQuality?: number;
    sameImageMaxDistance?: number;
    minorEditsMaxDistance?: number;
  },
): PhotoAlbumMatch {
  if (
    left.algorithmVersion !== right.algorithmVersion ||
    left.images.length === 0 ||
    left.images.length !== right.images.length
  ) {
    return { matched: false, strongestDistance: null, usedPerceptualHash: false };
  }
  const leftCanonicalHashes = left.images.map((image) => image.canonicalHash).sort();
  const rightCanonicalHashes = right.images.map((image) => image.canonicalHash).sort();
  if (leftCanonicalHashes.every((hash, index) => hash === rightCanonicalHashes[index])) {
    return { matched: true, strongestDistance: 0, usedPerceptualHash: false };
  }

  const minPdqQuality = normalizeBoundedInteger(
    options.minPdqQuality,
    PHOTO_PD_DEFAULT_MIN_QUALITY,
    0,
    100,
    'minPdqQuality',
  );
  const maxDistance =
    options.preset === 'SAME_IMAGE'
      ? normalizeBoundedInteger(
          options.sameImageMaxDistance,
          PHOTO_PD_SAME_IMAGE_MAX_DISTANCE,
          0,
          256,
          'sameImageMaxDistance',
        )
      : normalizeBoundedInteger(
          options.minorEditsMaxDistance,
          PHOTO_PD_MINOR_EDITS_MAX_DISTANCE,
          0,
          256,
          'minorEditsMaxDistance',
        );

  const candidates = left.images.map((leftImage) =>
    right.images.map((rightImage) => {
      if (leftImage.canonicalHash === rightImage.canonicalHash) {
        return { eligible: true, distance: 0, perceptual: false };
      }
      if (
        leftImage.pdqQuality < minPdqQuality ||
        rightImage.pdqQuality < minPdqQuality ||
        !isHexHash(leftImage.pdqHash) ||
        !isHexHash(rightImage.pdqHash)
      ) {
        return { eligible: false, distance: 257, perceptual: false };
      }
      const distance = hammingDistanceHex(leftImage.pdqHash, rightImage.pdqHash);
      return { eligible: distance <= maxDistance, distance, perceptual: true };
    }),
  );

  // A complete bipartite matching preserves duplicate multiplicity and prevents partial albums
  // from matching. Lower-distance edges are tried first to avoid consuming a scarce candidate.
  const rightOwners = new Array<number>(right.images.length).fill(-1);
  const matchedEdges = new Map<number, { distance: number; perceptual: boolean }>();
  const assign = (leftIndex: number, visited: Set<number>): boolean => {
    const rankedRightIndices = candidates[leftIndex]
      .map((candidate, rightIndex) => ({ candidate, rightIndex }))
      .filter(({ candidate }) => candidate.eligible)
      .sort((a, b) => a.candidate.distance - b.candidate.distance);

    for (const { candidate, rightIndex } of rankedRightIndices) {
      if (visited.has(rightIndex)) {
        continue;
      }
      visited.add(rightIndex);
      const previousOwner = rightOwners[rightIndex];
      if (previousOwner === -1 || assign(previousOwner, visited)) {
        rightOwners[rightIndex] = leftIndex;
        matchedEdges.set(leftIndex, {
          distance: candidate.distance,
          perceptual: candidate.perceptual,
        });
        return true;
      }
    }
    return false;
  };

  for (let leftIndex = 0; leftIndex < left.images.length; leftIndex += 1) {
    if (!assign(leftIndex, new Set())) {
      return { matched: false, strongestDistance: null, usedPerceptualHash: false };
    }
  }

  const edges = [...matchedEdges.values()];
  return {
    matched: true,
    strongestDistance: Math.max(...edges.map((edge) => edge.distance)),
    usedPerceptualHash: edges.some((edge) => edge.perceptual),
  };
}

export function hammingDistanceHex(left: string, right: string): number {
  const normalizedLeft = validateHexHash(left);
  const normalizedRight = validateHexHash(right);
  let distance = 0;
  for (let index = 0; index < normalizedLeft.length; index += 2) {
    let value =
      Number.parseInt(normalizedLeft.slice(index, index + 2), 16) ^
      Number.parseInt(normalizedRight.slice(index, index + 2), 16);
    while (value > 0) {
      distance += value & 1;
      value >>>= 1;
    }
  }
  return distance;
}

function isHexHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function validateHexHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isHexHash(normalized)) {
    throw new Error('Photo hash must be a 256-bit hexadecimal value');
  }
  return normalized;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return normalized;
}

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return normalized;
}
