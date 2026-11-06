import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from './photo-fingerprint-version';
import { readStandardJpegRecompressionRecipe } from './photo-jpeg-recompression';
import { photoResidualWindowsWithinBounds } from './photo-residual-windows';
import {
  PHOTO_RECOMPRESSION_VERSION,
  type PhotoRecompressionProof,
} from './photo-recompression-version';

// FLAG: Candidate hashes only locate independently verified original photographs.
// Neither a hash collision nor a low global error authorizes a duplicate action.
export async function recompressionCandidateHash(image: ReturnType<typeof sharp>): Promise<string> {
  const pixels = await image
    .clone()
    .rotate()
    .greyscale()
    .removeAlpha()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      hash = (hash << 1n) | BigInt(pixels[y * 9 + x]! > pixels[y * 9 + x + 1]!);
    }
  }
  return hash.toString(16).padStart(16, '0');
}

type RecompressionRejection =
  | 'unsupported_image'
  | 'unsupported_multi_frame'
  | 'image_byte_limit_exceeded'
  | 'image_pixel_limit_exceeded'
  | 'album_decode_budget_exceeded'
  | 'decode_deadline_exceeded';

export class PhotoRecompressionRejectedError extends Error {
  constructor(readonly reason: RecompressionRejection) {
    super('Photo recompression comparison rejected');
    this.name = 'PhotoRecompressionRejectedError';
  }
}

export type PhotoRecompressionResult = Readonly<{
  kind: 'recompression';
  matched: boolean;
  proof: PhotoRecompressionProof;
  decodeCost: { encodedBytes: number; pixels: number };
}>;

export type PhotoRecompressionLimits = Readonly<{
  deadlineAtMs: number;
  maxInputBytes: number;
  maxInputPixels: number;
  remainingEncodedBytes: number;
  remainingPixels: number;
}>;

// FLAG: The pair uses the existing total native budget, never two independent maxima.
// A smaller approximate lane limits simultaneous raw/blurred raster memory in the 1 GiB cgroup.
const MAX_PAIR_PIXELS = 8_000_000;

function requireTime(deadlineAtMs: number): void {
  if (Date.now() >= deadlineAtMs)
    throw new PhotoRecompressionRejectedError('decode_deadline_exceeded');
}

function canonicalHash(data: Buffer, width: number, height: number): string {
  return createHash('sha256')
    .update(`${PHOTO_FINGERPRINT_ALGORITHM_VERSION}\0${width}x${height}x4\0`)
    .update(data)
    .digest('hex');
}

function residualWithinBounds(
  original: Buffer,
  current: Buffer,
  width: number,
  height: number,
  channels: number,
  limits: { rms: number; maximum: number; tileRms: number; tileMean?: number; meanDrift?: number },
  deadlineAtMs: number,
): boolean {
  if (original.length !== width * height * channels || current.length !== original.length)
    throw new PhotoRecompressionRejectedError('unsupported_image');
  let squared = 0;
  const signed = new Array<number>(channels).fill(0);
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) requireTime(deadlineAtMs);
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const index = (y * width + x) * channels + channel;
        const difference = original[index]! - current[index]!;
        if (Math.abs(difference) > limits.maximum) return false;
        squared += difference * difference;
        signed[channel]! += difference;
      }
    }
  }
  if (squared > original.length * limits.rms ** 2) return false;
  if (
    limits.meanDrift !== undefined &&
    signed.some((sum) => Math.abs(sum) > width * height * limits.meanDrift!)
  )
    return false;
  return photoResidualWindowsWithinBounds(original, current, width, height, channels, limits, () =>
    requireTime(deadlineAtMs),
  );
}

export async function verifyNativePhotoRecompression(
  original: Uint8Array,
  current: Uint8Array,
  limits: PhotoRecompressionLimits,
): Promise<PhotoRecompressionResult> {
  requireTime(limits.deadlineAtMs);
  const encodedBytes = original.byteLength + current.byteLength;
  if (!original.byteLength || !current.byteLength || encodedBytes > limits.maxInputBytes)
    throw new PhotoRecompressionRejectedError('image_byte_limit_exceeded');
  if (encodedBytes > limits.remainingEncodedBytes)
    throw new PhotoRecompressionRejectedError('album_decode_budget_exceeded');
  const image = (bytes: Uint8Array) =>
    sharp(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      animated: false,
      failOn: 'warning',
      sequentialRead: true,
      limitInputPixels: limits.maxInputPixels,
    });
  const first = image(original),
    second = image(current);
  const metadata: Awaited<ReturnType<typeof first.metadata>>[] = [];
  for (const value of [first, second]) {
    try {
      metadata.push(await value.metadata());
    } catch (error) {
      // FLAG: Malformed or over-budget source data is a typed refusal, never a reason
      // to report an unavailable native process and recycle a healthy sandbox.
      throw new PhotoRecompressionRejectedError(
        error instanceof Error && error.message.toLowerCase().includes('pixel limit')
          ? 'image_pixel_limit_exceeded'
          : 'unsupported_image',
      );
    }
  }
  let pixels = 0;
  for (const row of metadata) {
    if (
      !row.width ||
      !row.height ||
      row.depth !== 'uchar' ||
      !['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(row.format ?? '')
    )
      throw new PhotoRecompressionRejectedError('unsupported_image');
    if ((row.pages ?? 1) !== 1 || (row.pageHeight !== undefined && row.pageHeight !== row.height))
      throw new PhotoRecompressionRejectedError('unsupported_multi_frame');
    pixels += row.width * row.height;
  }
  if (pixels > Math.min(limits.maxInputPixels, MAX_PAIR_PIXELS))
    throw new PhotoRecompressionRejectedError('image_pixel_limit_exceeded');
  if (pixels > limits.remainingPixels)
    throw new PhotoRecompressionRejectedError('album_decode_budget_exceeded');
  requireTime(limits.deadlineAtMs);
  const decode = async (value: ReturnType<typeof sharp>) => {
    try {
      return await value
        .rotate()
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new PhotoRecompressionRejectedError('unsupported_image');
    }
  };
  const a = await decode(first);
  const b = await decode(second);
  const proof: PhotoRecompressionProof = {
    version: PHOTO_RECOMPRESSION_VERSION,
    originalHash: canonicalHash(a.data, a.info.width, a.info.height),
    currentHash: canonicalHash(b.data, b.info.width, b.info.height),
  };
  const result = (matched: boolean): PhotoRecompressionResult => ({
    kind: 'recompression',
    matched,
    proof,
    decodeCost: { encodedBytes, pixels },
  });
  if (
    a.info.width !== b.info.width ||
    a.info.height !== b.info.height ||
    a.info.channels !== 4 ||
    b.info.channels !== 4
  )
    return result(false);
  if (proof.originalHash === proof.currentHash) return result(true);
  if (a.info.width < 64 || a.info.height < 64) return result(false);
  // FLAG: Recompression tolerance never flattens transparency or ignores alpha edits.
  // Only opaque photographs enter the approximate path; exact RGBA remains available above.
  for (let index = 3; index < a.data.length; index += 4)
    if (a.data[index] !== 255 || b.data[index] !== 255) return result(false);
  const raw = { width: a.info.width, height: a.info.height, channels: 4 as const };
  const verifyStandardJpeg = async (): Promise<boolean> => {
    const recipe = readStandardJpegRecompressionRecipe(current);
    if (!recipe) return false;
    requireTime(limits.deadlineAtMs);
    // FLAG: One known encoder recipe may explain stronger JPEG artifacts. The recipe
    // never proves equality: its entire decoded RGBA raster must match the independently
    // downloaded current image. No quality search, resize, relaxed residual or new anchor.
    let encoded: Buffer;
    try {
      encoded = await sharp(a.data, { raw })
        .removeAlpha()
        .jpeg({
          ...recipe,
          progressive: false,
          trellisQuantisation: false,
          overshootDeringing: false,
          optimiseScans: false,
          optimiseCoding: true,
          quantisationTable: 0,
        })
        .toBuffer();
    } catch {
      throw new PhotoRecompressionRejectedError('unsupported_image');
    }
    requireTime(limits.deadlineAtMs);
    if (encoded.length > limits.maxInputBytes) return false;
    // FLAG: The current input already has an independently decoded full RGBA proof.
    // Exact encoded equality makes a third decode redundant; differing encodings
    // still require the full canonical-raster check below.
    if (encoded.equals(Buffer.from(current.buffer, current.byteOffset, current.byteLength)))
      return true;
    const reconstructed = await decode(image(encoded));
    requireTime(limits.deadlineAtMs);
    return (
      reconstructed.info.width === raw.width &&
      reconstructed.info.height === raw.height &&
      reconstructed.info.channels === 4 &&
      canonicalHash(reconstructed.data, raw.width, raw.height) === proof.currentHash
    );
  };
  // FLAG: Exact reproduction is sufficient on its own. Run it before allocating
  // grayscale/blur planes; a refusal still uses every existing residual guard.
  if (await verifyStandardJpeg()) return result(true);
  const grayA = await sharp(a.data, { raw }).removeAlpha().greyscale().raw().toBuffer();
  const grayB = await sharp(b.data, { raw }).removeAlpha().greyscale().raw().toBuffer();
  if (
    !residualWithinBounds(
      grayA,
      grayB,
      raw.width,
      raw.height,
      1,
      { rms: 3.5, maximum: 40, tileRms: 11.5 },
      limits.deadlineAtMs,
    )
  )
    return result(false);
  const blurredA = await sharp(grayA, { raw: { ...raw, channels: 1 } })
    .blur(1)
    .greyscale()
    .raw()
    .toBuffer();
  const blurredB = await sharp(grayB, { raw: { ...raw, channels: 1 } })
    .blur(1)
    .greyscale()
    .raw()
    .toBuffer();
  if (
    !residualWithinBounds(
      blurredA,
      blurredB,
      raw.width,
      raw.height,
      1,
      { rms: 2, maximum: 18, tileRms: 6.5, tileMean: 4.75 },
      limits.deadlineAtMs,
    )
  )
    return result(false);
  const colorA = await sharp(a.data, { raw }).removeAlpha().blur(1).raw().toBuffer();
  const colorB = await sharp(b.data, { raw }).removeAlpha().blur(1).raw().toBuffer();
  const colorMatched = residualWithinBounds(
    colorA,
    colorB,
    raw.width,
    raw.height,
    3,
    { rms: 3.5, maximum: 56, tileRms: 18, meanDrift: 1 },
    limits.deadlineAtMs,
  );
  return result(colorMatched);
}
