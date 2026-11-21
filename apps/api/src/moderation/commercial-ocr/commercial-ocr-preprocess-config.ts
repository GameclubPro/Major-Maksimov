import type { CommercialOcrBoundingBox } from './native-tesseract-ocr.types';

const DEFAULT_MAX_INPUT_PIXELS = 40_000_000;
const DEFAULT_MAX_OUTPUT_PIXELS = 3_000_000;
const DEFAULT_MAX_SIDE = 2_000;

export const COMMERCIAL_OCR_SHARP_CONCURRENCY = 1;
export const COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS = 5;

export const COMMERCIAL_OCR_PREPROCESS_PROFILES = Object.freeze({
  primary: 'gray-bounded-v4',
  confirmation: 'normalized-threshold160-v4',
} as const);

export type CommercialOcrPassName = keyof typeof COMMERCIAL_OCR_PREPROCESS_PROFILES;

export type CommercialOcrPreprocessLimits = Readonly<{
  maxInputPixels: number;
  maxOutputPixels: number;
  maxSide: number;
}>;

export interface CommercialOcrPreprocessConfigReader {
  get(propertyPath: string): unknown;
}

export const COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS: CommercialOcrPreprocessLimits =
  Object.freeze({
    maxInputPixels: DEFAULT_MAX_INPUT_PIXELS,
    maxOutputPixels: DEFAULT_MAX_OUTPUT_PIXELS,
    maxSide: DEFAULT_MAX_SIDE,
  });

export type CommercialOcrPreparedImage = {
  bytes: Buffer;
  width: number;
  height: number;
};

export type CommercialOcrPreprocessOptions = {
  deadlineAtMs?: number;
  crop?: CommercialOcrBoundingBox;
};

export function readCommercialOcrCrop(value: unknown): CommercialOcrBoundingBox | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { left, top, width, height } = value as Partial<CommercialOcrBoundingBox>;
  if (
    Object.keys(value).length !== 4 ||
    !Number.isSafeInteger(left) ||
    left! < 0 ||
    !Number.isSafeInteger(top) ||
    top! < 0 ||
    !Number.isSafeInteger(width) ||
    width! < 1 ||
    !Number.isSafeInteger(height) ||
    height! < 1 ||
    left! + width! > 4_000 ||
    top! + height! > 4_000 ||
    width! * height! > 512_000
  )
    return null;
  return { left: left!, top: top!, width: width!, height: height! };
}

export class CommercialOcrImageRejectedError extends Error {
  constructor(
    readonly reason: 'invalid_image' | 'too_many_pixels' | 'animated_image' | 'processing_timeout',
  ) {
    super(`Commercial OCR image rejected: ${reason}`);
    this.name = 'CommercialOcrImageRejectedError';
  }
}

export function resolveCommercialOcrPreprocessLimits(
  configService?: CommercialOcrPreprocessConfigReader,
): CommercialOcrPreprocessLimits {
  return Object.freeze({
    maxInputPixels: readPositiveInt(
      configService?.get('COMMERCIAL_OCR_MAX_INPUT_PIXELS'),
      DEFAULT_MAX_INPUT_PIXELS,
    ),
    maxOutputPixels: readPositiveInt(
      configService?.get('COMMERCIAL_OCR_MAX_OUTPUT_PIXELS'),
      DEFAULT_MAX_OUTPUT_PIXELS,
    ),
    maxSide: readPositiveInt(configService?.get('COMMERCIAL_OCR_MAX_SIDE'), DEFAULT_MAX_SIDE),
  });
}

export function resolveCommercialOcrPreprocessCacheProfile(
  pass: CommercialOcrPassName,
  limits: CommercialOcrPreprocessLimits,
): string {
  return [
    COMMERCIAL_OCR_PREPROCESS_PROFILES[pass],
    `i${limits.maxInputPixels}`,
    `o${limits.maxOutputPixels}`,
    `s${limits.maxSide}`,
  ].join('.');
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
