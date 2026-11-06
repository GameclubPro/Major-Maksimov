import sharp from 'sharp';
import { recompressionCandidateHash, verifyNativePhotoRecompression } from './photo-recompression';

const width = 512;
const height = 512;
const limits = () => ({
  deadlineAtMs: Date.now() + 10_000,
  maxInputBytes: 16_777_216,
  maxInputPixels: 40_000_000,
  remainingEncodedBytes: 16_777_216,
  remainingPixels: 40_000_000,
});

function poster(
  options: { phone?: string; price?: string; smallText?: string; color?: string } = {},
) {
  return Buffer.from(`<svg width="${width}" height="${height}">
    <defs><linearGradient id="g"><stop stop-color="#243b53"/><stop offset="1" stop-color="#8fadc1"/></linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <circle cx="180" cy="200" r="110" fill="${options.color ?? '#d0a040'}"/>
    <circle cx="180" cy="200" r="60" fill="#243b53"/>
    <path d="M0 330L512 290L512 380L0 420Z" fill="#e5e1d7"/>
    <text x="30" y="60" font-family="DejaVu Sans" font-size="34" fill="white">TYRE SERVICE</text>
    <text x="30" y="445" font-family="DejaVu Sans" font-size="28" fill="white">${options.phone ?? '8-902-009-99-49'}</text>
    <text x="30" y="485" font-family="DejaVu Sans" font-size="28" fill="white">${options.price ?? 'Price 1000'}</text>
    <text x="300" y="180" font-family="DejaVu Sans" font-size="10" fill="white">${options.smallText ?? 'Model 1234'}</text>
  </svg>`);
}

async function encoded(source = poster(), quality = 92) {
  return sharp(source).webp({ quality }).toBuffer();
}

describe('native photo recompression evidence', () => {
  it('keeps exact SHA evidence while accepting independently recompressed copies', async () => {
    const original = await encoded();
    const current = await encoded(poster(), 89);
    const result = await verifyNativePhotoRecompression(original, current, limits());
    expect(result.matched).toBe(true);
    expect(result.proof.originalHash).not.toBe(result.proof.currentHash);
    expect(result.decodeCost).toEqual({
      encodedBytes: original.length + current.length,
      pixels: 2 * width * height,
    });
    expect(await recompressionCandidateHash(sharp(original))).toBe(
      await recompressionCandidateHash(sharp(current)),
    );
  });

  it.each([50, 65, 80, 90])(
    'recognizes an unchanged JPEG after another encode at quality %i',
    async (quality) => {
      const original = await sharp(poster()).jpeg({ quality: 92 }).toBuffer();
      const current = await sharp(original).jpeg({ quality }).toBuffer();
      const result = await verifyNativePhotoRecompression(original, current, limits());
      expect(result.matched).toBe(true);
      expect(result.proof.originalHash).not.toBe(result.proof.currentHash);
    },
  );

  it.each(
    [50, 80, 95, 100].flatMap((quality) =>
      (['4:2:0', '4:4:4'] as const).flatMap((chromaSubsampling) =>
        [false, true].map((progressive) => ({ quality, chromaSubsampling, progressive })),
      ),
    ),
  )(
    'verifies the full raster for a standard JPEG $quality/$chromaSubsampling/$progressive',
    async (recipe) => {
      const original = await sharp(poster()).png().toBuffer();
      const current = await sharp(original).jpeg(recipe).toBuffer();
      const result = await verifyNativePhotoRecompression(original, current, limits());
      expect(result.matched).toBe(true);
      expect(result.decodeCost).toEqual({
        encodedBytes: original.length + current.length,
        pixels: 2 * width * height,
      });
    },
  );

  it.each([
    ['phone', { phone: '8-902-009-99-48' }],
    ['price', { price: 'Price 1009' }],
    ['small text', { smallText: 'Model 1239' }],
    ['color', { color: '#40a0d0' }],
  ])('preserves changed %s after stronger JPEG compression', async (_name, change) => {
    const original = await sharp(poster()).jpeg({ quality: 92 }).toBuffer();
    const current = await sharp(poster(change)).jpeg({ quality: 65 }).toBuffer();
    expect((await verifyNativePhotoRecompression(original, current, limits())).matched).toBe(false);
  });

  it.each([
    ['one phone digit', { phone: '8-902-009-99-48' }],
    ['one price digit', { price: 'Price 1009' }],
    ['small thin text', { smallText: 'Model 1239' }],
    ['a product color', { color: '#40a0d0' }],
  ])('preserves an image with changed %s', async (_label, change) => {
    const original = await encoded();
    const edited = await encoded(poster(change), 89);
    expect((await verifyNativePhotoRecompression(original, edited, limits())).matched).toBe(false);
  });

  it('rejects a strong single-pixel change even when its global error is tiny', async () => {
    const data = Buffer.alloc(width * height * 3, 245);
    const original = await sharp(data, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const offset = (255 * width + 255) * 3;
    data.fill(0, offset, offset + 3);
    const current = await sharp(data, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    expect((await verifyNativePhotoRecompression(original, current, limits())).matched).toBe(false);
  });

  it('does not flatten alpha, resize or crop images into equivalence', async () => {
    const original = await sharp(poster()).ensureAlpha().png().toBuffer();
    const alternatives = [
      await sharp(poster()).removeAlpha().ensureAlpha(0.99).png().toBuffer(),
      await sharp(poster()).resize(511, 512).png().toBuffer(),
      await sharp(poster()).extract({ left: 1, top: 0, width: 511, height: 512 }).png().toBuffer(),
    ];
    for (const current of alternatives)
      expect((await verifyNativePhotoRecompression(original, current, limits())).matched).toBe(
        false,
      );
  });

  it('preserves different content despite a shared poster template and lossy JPEG encoding', async () => {
    const original = await sharp(poster()).jpeg({ quality: 92 }).toBuffer();
    for (const source of [
      poster({ price: 'Price 9000', phone: '8-902-009-99-48' }),
      poster({ smallText: 'Model 9999', color: '#d0a099' }),
    ]) {
      const current = await sharp(source).jpeg({ quality: 50, progressive: true }).toBuffer();
      expect((await verifyNativePhotoRecompression(original, current, limits())).matched).toBe(
        false,
      );
    }
  });

  it('does not treat rotations, reflections or added borders as JPEG recompression evidence', async () => {
    const original = await sharp(poster()).jpeg({ quality: 92 }).toBuffer();
    const alternatives = [
      await sharp(original).rotate(90).jpeg({ quality: 65 }).toBuffer(),
      await sharp(original).rotate(180).jpeg({ quality: 65 }).toBuffer(),
      await sharp(original).flop().jpeg({ quality: 65 }).toBuffer(),
      await sharp(original)
        .extend({ top: 1, bottom: 1, left: 1, right: 1 })
        .jpeg({ quality: 65 })
        .toBuffer(),
    ];
    for (const current of alternatives)
      expect((await verifyNativePhotoRecompression(original, current, limits())).matched).toBe(
        false,
      );
  });

  it('charges both inputs against the total byte/pixel budget and original deadline', async () => {
    const original = await encoded();
    await expect(
      verifyNativePhotoRecompression(original, original, {
        ...limits(),
        maxInputBytes: original.length,
      }),
    ).rejects.toMatchObject({ reason: 'image_byte_limit_exceeded' });
    await expect(
      verifyNativePhotoRecompression(original, original, {
        ...limits(),
        remainingPixels: width * height,
      }),
    ).rejects.toMatchObject({ reason: 'album_decode_budget_exceeded' });
    await expect(
      verifyNativePhotoRecompression(original, original, {
        ...limits(),
        deadlineAtMs: Date.now() - 1,
      }),
    ).rejects.toMatchObject({ reason: 'decode_deadline_exceeded' });
  });
});
