import sharp, { type Sharp } from 'sharp';

import {
  COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS,
  type CommercialOcrPassName,
} from './commercial-ocr-preprocess-config';
import { NativeOcrImagePreprocessor } from './native-ocr-image-preprocessor';

describe('NativeOcrImagePreprocessor output bounds', () => {
  it.each([
    { width: 1_800, height: 1_667, maxOutputPixels: 3_000_000, maxSide: 2_000 },
    { width: 1_667, height: 1_800, maxOutputPixels: 3_000_000, maxSide: 2_000 },
    { width: 7, height: 3, maxOutputPixels: 1, maxSide: 10 },
    { width: 1, height: 4_000, maxOutputPixels: 13, maxSide: 2_000 },
    { width: 4_000, height: 1, maxOutputPixels: 13, maxSide: 2_000 },
  ])('keeps both passes within the integer area ceiling for $width x $height', async (fixture) => {
    const input = await sharp({
      create: {
        width: fixture.width,
        height: fixture.height,
        channels: 3,
        background: '#64839a',
      },
    })
      .png()
      .toBuffer();
    const preprocessor = new NativeOcrImagePreprocessor({
      ...COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS,
      maxOutputPixels: fixture.maxOutputPixels,
      maxSide: fixture.maxSide,
    });

    for (const pass of ['primary', 'confirmation'] as const) {
      const prepared = await preprocessor.prepare(input, pass);
      const actual = await sharp(prepared.bytes).metadata();
      expect(actual.width).toBe(prepared.width);
      expect(actual.height).toBe(prepared.height);
      expect(prepared.width).toBeGreaterThanOrEqual(1);
      expect(prepared.height).toBeGreaterThanOrEqual(1);
      expect(prepared.width).toBeLessThanOrEqual(fixture.maxSide);
      expect(prepared.height).toBeLessThanOrEqual(fixture.maxSide);
      expect(prepared.width * prepared.height).toBeLessThanOrEqual(fixture.maxOutputPixels);
    }
  });

  it.each([
    { width: 1_800, height: 1_667, reason: 'too_many_pixels' },
    { width: 2_001, height: 1, reason: 'too_many_pixels' },
    { width: 0, height: 1, reason: 'invalid_image' },
    { width: 1.5, height: 1, reason: 'invalid_image' },
  ])('rejects and wipes an out-of-contract native raster $width x $height', async (fixture) => {
    const input = await sharp({
      create: { width: 3, height: 2, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const pixels = Buffer.from([1, 2, 3]);
    const prototype = Object.getPrototypeOf(sharp()) as Pick<Sharp, 'toBuffer'>;
    const toBuffer = jest.spyOn(prototype, 'toBuffer').mockResolvedValueOnce({
      data: pixels,
      info: {
        format: 'png',
        width: fixture.width,
        height: fixture.height,
        channels: 3,
        size: 3,
        premultiplied: false,
        hasAlpha: false,
      },
    });
    try {
      const preprocessor = new NativeOcrImagePreprocessor(COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS);
      await expect(preprocessor.prepare(input, 'primary')).rejects.toMatchObject({
        reason: fixture.reason,
      });
      expect(pixels).toEqual(Buffer.alloc(3));
    } finally {
      toBuffer.mockRestore();
    }
  });

  it('extracts a bounded crop from the oriented and resized primary raster', async () => {
    const input = await sharp({
      create: { width: 80, height: 50, channels: 3, background: '#64839a' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const preprocessor = new NativeOcrImagePreprocessor(COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS);
    const primary = await preprocessor.prepare(input, 'primary');
    const crop = { left: 3, top: 7, width: 40, height: 20 };
    const region = await preprocessor.prepare(input, 'primary', { crop });
    const reference = await sharp(primary.bytes).extract(crop).raw().toBuffer();
    await expect(sharp(region.bytes).raw().toBuffer()).resolves.toEqual(reference);
    await expect(
      preprocessor.prepare(input, 'primary', { crop: { ...crop, left: primary.width - 1 } }),
    ).rejects.toMatchObject({ reason: 'invalid_image' });
  });

  it.each([8, 16] as const)(
    'preserves alpha and both pass pixels for a %s-bit PNG outside the corrected area boundary',
    async (bitDepth) => {
      const source = Buffer.alloc(64 * 48 * 4);
      for (let offset = 0; offset < source.length; offset += 4) {
        source[offset] = offset % 256;
        source[offset + 1] = (offset * 3) % 256;
        source[offset + 2] = (offset * 5) % 256;
        source[offset + 3] = (offset * 7) % 256;
      }
      let inputPipeline = sharp(source, { raw: { width: 64, height: 48, channels: 4 } });
      if (bitDepth === 16) inputPipeline = inputPipeline.toColourspace('rgb16');
      const input = await inputPipeline.png().toBuffer();
      await expect(sharp(input).metadata()).resolves.toMatchObject({
        hasAlpha: true,
        bitsPerSample: bitDepth,
      });
      const preprocessor = new NativeOcrImagePreprocessor(COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS);

      for (const pass of ['primary', 'confirmation'] as const) {
        const prepared = await preprocessor.prepare(input, pass);
        const reference = await unchangedPassPixels(input, pass);
        const actual = await sharp(prepared.bytes).raw().toBuffer({ resolveWithObject: true });
        expect(actual.info.hasAlpha).toBe(true);
        expect(actual.info.channels).toBe(reference.info.channels);
        expect(actual.data).toEqual(reference.data);
      }
    },
  );
});

async function unchangedPassPixels(input: Buffer, pass: CommercialOcrPassName) {
  let pipeline = sharp(input, {
    limitInputPixels: COMMERCIAL_OCR_DEFAULT_PREPROCESS_LIMITS.maxInputPixels,
    sequentialRead: true,
    animated: false,
  })
    .rotate()
    .resize(64, 48, { fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true })
    .grayscale();
  if (pass === 'confirmation') pipeline = pipeline.normalize().threshold(160, { greyscale: true });
  const png = await pipeline.png({ compressionLevel: 1, adaptiveFiltering: false }).toBuffer();
  return sharp(png).raw().toBuffer({ resolveWithObject: true });
}
