import sharp, { type Metadata, type OutputInfo } from 'sharp';

import {
  COMMERCIAL_OCR_SHARP_CONCURRENCY,
  COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS,
  CommercialOcrImageRejectedError,
  readCommercialOcrCrop,
  type CommercialOcrPassName,
  type CommercialOcrPreparedImage,
  type CommercialOcrPreprocessOptions,
  type CommercialOcrPreprocessLimits,
} from './commercial-ocr-preprocess-config';

export * from './commercial-ocr-preprocess-config';

const CONFIRMATION_THRESHOLD = 160;

export class NativeOcrImagePreprocessor {
  constructor(private readonly limits: CommercialOcrPreprocessLimits) {
    sharp.concurrency(COMMERCIAL_OCR_SHARP_CONCURRENCY);
  }

  async prepare(
    input: Buffer,
    pass: CommercialOcrPassName,
    options: CommercialOcrPreprocessOptions = {},
  ): Promise<CommercialOcrPreparedImage> {
    const crop = options.crop === undefined ? undefined : readCommercialOcrCrop(options.crop);
    if (crop === null || (crop !== undefined && pass !== 'primary')) {
      throw new CommercialOcrImageRejectedError('invalid_image');
    }
    let metadata: Metadata;
    try {
      metadata = await sharp(input, { limitInputPixels: this.limits.maxInputPixels })
        .timeout({ seconds: resolveSharpTimeoutSeconds(options.deadlineAtMs) })
        .metadata();
    } catch (error: unknown) {
      if (isProcessingTimeoutError(error)) {
        throw new CommercialOcrImageRejectedError('processing_timeout');
      }
      if (isPixelLimitError(error)) {
        throw new CommercialOcrImageRejectedError('too_many_pixels');
      }
      throw new CommercialOcrImageRejectedError('invalid_image');
    }
    if (!metadata.width || !metadata.height) {
      throw new CommercialOcrImageRejectedError('invalid_image');
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new CommercialOcrImageRejectedError('animated_image');
    }

    const inputPixels = metadata.width * metadata.height;
    if (!Number.isSafeInteger(inputPixels) || inputPixels > this.limits.maxInputPixels) {
      throw new CommercialOcrImageRejectedError('too_many_pixels');
    }
    const swapsAxes =
      metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const orientedWidth = swapsAxes ? metadata.height : metadata.width;
    const orientedHeight = swapsAxes ? metadata.width : metadata.height;
    const outputScale = Math.min(
      1,
      this.limits.maxSide / Math.max(orientedWidth, orientedHeight),
      Math.sqrt(this.limits.maxOutputPixels / inputPixels),
    );
    let width = Math.max(1, Math.min(this.limits.maxSide, Math.round(orientedWidth * outputScale)));
    let height = Math.max(
      1,
      Math.min(this.limits.maxSide, Math.round(orientedHeight * outputScale)),
    );
    // FLAG: Independent rounding can exceed the area ceiling even when the floating scale is safe.
    if (width * height > this.limits.maxOutputPixels) {
      if (width >= height) {
        width = Math.max(1, Math.floor(this.limits.maxOutputPixels / height));
      } else {
        height = Math.max(1, Math.floor(this.limits.maxOutputPixels / width));
      }
    }

    let pipeline = sharp(input, {
      limitInputPixels: this.limits.maxInputPixels,
      sequentialRead: true,
      animated: false,
    })
      .timeout({ seconds: resolveSharpTimeoutSeconds(options.deadlineAtMs) })
      .rotate()
      .resize(width, height, { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true })
      .grayscale();
    if (pass === 'confirmation') {
      pipeline = pipeline.normalize().threshold(CONFIRMATION_THRESHOLD, { greyscale: true });
    }
    let prepared: { data: Buffer; info: OutputInfo };
    try {
      prepared = await pipeline
        .png({ compressionLevel: 1, adaptiveFiltering: false })
        .toBuffer({ resolveWithObject: true });
    } catch (error: unknown) {
      if (isProcessingTimeoutError(error)) {
        throw new CommercialOcrImageRejectedError('processing_timeout');
      }
      if (isPixelLimitError(error)) {
        throw new CommercialOcrImageRejectedError('too_many_pixels');
      }
      throw new CommercialOcrImageRejectedError('invalid_image');
    }
    const outputPixels = prepared.info.width * prepared.info.height;
    if (
      !Number.isSafeInteger(prepared.info.width) ||
      !Number.isSafeInteger(prepared.info.height) ||
      prepared.info.width < 1 ||
      prepared.info.height < 1 ||
      !Number.isSafeInteger(outputPixels)
    ) {
      prepared.data.fill(0);
      throw new CommercialOcrImageRejectedError('invalid_image');
    }
    // FLAG: Check native output as well as requested dimensions before it crosses the sandbox.
    if (
      prepared.info.width > this.limits.maxSide ||
      prepared.info.height > this.limits.maxSide ||
      outputPixels > this.limits.maxOutputPixels
    ) {
      prepared.data.fill(0);
      throw new CommercialOcrImageRejectedError('too_many_pixels');
    }
    if (crop) {
      // FLAG: Coordinates refer to the same oriented, resized grayscale raster as the
      // primary OCR pass. Decode and extract only inside the isolated native sandbox.
      try {
        if (
          crop.left + crop.width > prepared.info.width ||
          crop.top + crop.height > prepared.info.height
        ) {
          throw new CommercialOcrImageRejectedError('invalid_image');
        }
        const bytes = await sharp(prepared.data, { limitInputPixels: this.limits.maxOutputPixels })
          .timeout({ seconds: resolveSharpTimeoutSeconds(options.deadlineAtMs) })
          .extract(crop)
          .png({ compressionLevel: 1, adaptiveFiltering: false })
          .toBuffer();
        return { bytes, width: crop.width, height: crop.height };
      } catch (error: unknown) {
        if (isProcessingTimeoutError(error)) {
          throw new CommercialOcrImageRejectedError('processing_timeout');
        }
        throw new CommercialOcrImageRejectedError('invalid_image');
      } finally {
        prepared.data.fill(0);
      }
    }
    return {
      bytes: prepared.data,
      width: prepared.info.width,
      height: prepared.info.height,
    };
  }
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('pixel limit');
}

function isProcessingTimeoutError(error: unknown): boolean {
  return error instanceof CommercialOcrImageRejectedError
    ? error.reason === 'processing_timeout'
    : error instanceof Error && error.message.toLowerCase().includes('timeout');
}

function resolveSharpTimeoutSeconds(deadlineAtMs: number | undefined): number {
  if (deadlineAtMs === undefined) {
    return COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS;
  }
  const remainingWholeSeconds = Math.floor((deadlineAtMs - Date.now()) / 1_000);
  if (!Number.isSafeInteger(deadlineAtMs) || remainingWholeSeconds < 1) {
    throw new CommercialOcrImageRejectedError('processing_timeout');
  }
  return Math.min(COMMERCIAL_OCR_SHARP_PROCESSING_TIMEOUT_SECONDS, remainingWholeSeconds);
}
