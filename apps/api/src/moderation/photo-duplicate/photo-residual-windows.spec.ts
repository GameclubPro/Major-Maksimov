import { photoResidualWindowsWithinBounds } from './photo-residual-windows';

type WindowLimits = Parameters<typeof photoResidualWindowsWithinBounds>[5];

function naiveRectangles(
  original: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
  channels: number,
  limits: WindowLimits,
): boolean {
  for (let top = 0; top < height; top += 4) {
    for (let left = 0; left < width; left += 4) {
      const differences: number[] = [];
      for (let row = top; row < Math.min(height, top + 8); row += 1) {
        const start = (row * width + left) * channels;
        const end = (row * width + Math.min(width, left + 8)) * channels;
        for (let offset = start; offset < end; offset += 1)
          differences.push(original[offset]! - current[offset]!);
      }
      const squares = differences.reduce((total, difference) => total + difference ** 2, 0);
      const signed = differences.reduce((total, difference) => total + difference, 0);
      if (
        squares > differences.length * limits.tileRms ** 2 ||
        (limits.tileMean !== undefined && Math.abs(signed) > differences.length * limits.tileMean)
      )
        return false;
    }
  }
  return true;
}

function signedNoise(width: number, height: number, channels: number) {
  let seed = (Math.imul(width, 65_537) ^ Math.imul(height, 257) ^ channels) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const original = new Uint8Array(width * height * channels);
  const current = new Uint8Array(original.length);
  for (let index = 0; index < original.length; index += 1) {
    original[index] = 64 + (random() % 128);
    const difference = (random() % 17) - 8;
    current[index] = original[index]! - difference;
  }
  return { original, current };
}

describe('full-resolution residual windows', () => {
  const sizes = [1, 4, 7, 8, 9, 63, 64, 65];
  const shapes = sizes.flatMap((width) =>
    sizes.flatMap((height) => [1, 3].map((channels) => ({ width, height, channels }))),
  );

  it.each(shapes)(
    'agrees with independent rectangles for signed noise at $width × $height × $channels',
    ({ width, height, channels }) => {
      const { original, current } = signedNoise(width, height, channels);
      const rules: WindowLimits[] = [
        { tileRms: 0 },
        { tileRms: 3 },
        { tileRms: 6.5 },
        { tileRms: 8 },
        { tileRms: 8, tileMean: 0 },
        { tileRms: 8, tileMean: 1 },
        { tileRms: 8, tileMean: 8 },
      ];
      for (const rule of rules) {
        const match = photoResidualWindowsWithinBounds(
          original,
          current,
          width,
          height,
          channels,
          rule,
          () => undefined,
        );
        expect({ rule, match }).toEqual({
          rule,
          match: naiveRectangles(original, current, width, height, channels, rule),
        });
      }
    },
  );

  it.each([1, 3])(
    'preserves exact RMS and positive/negative mean boundaries for %i channels',
    (channels) => {
      const original = new Uint8Array(9 * 9 * channels).fill(5);
      const current = new Uint8Array(original.length);
      for (const [first, second] of [
        [original, current],
        [current, original],
      ]) {
        const check = (rule: WindowLimits) =>
          photoResidualWindowsWithinBounds(first!, second!, 9, 9, channels, rule, () => undefined);
        expect(check({ tileRms: 5, tileMean: 5 })).toBe(true);
        expect(check({ tileRms: 4.999, tileMean: 5 })).toBe(false);
        expect(check({ tileRms: 5, tileMean: 4.999 })).toBe(false);
      }
    },
  );

  it('preserves signed cancellation across color channels in each mean window', () => {
    const original = new Uint8Array(9 * 9 * 3).fill(128);
    const current = Uint8Array.from(original, (_value, index) => [121, 128, 135][index % 3]!);
    expect(
      photoResidualWindowsWithinBounds(
        original,
        current,
        9,
        9,
        3,
        { tileRms: 7, tileMean: 0 },
        () => undefined,
      ),
    ).toBe(true);
  });

  it.each<[number, boolean]>([
    [19, true],
    [20, false],
  ])('uses the clipped bottom-right sample count for residual %i', (difference, expected) => {
    const original = new Uint8Array(65 * 67).fill(128);
    const current = original.slice();
    current[66 * 65 + 64] = current[66 * 65 + 64]! + difference;
    expect(
      photoResidualWindowsWithinBounds(
        original,
        current,
        65,
        67,
        1,
        { tileRms: 11.5 },
        () => undefined,
      ),
    ).toBe(expected);
  });

  it('retains overlapping windows across non-overlapping tile boundaries', () => {
    const original = new Uint8Array(64 * 64).fill(128);
    const current = original.slice();
    for (let y = 6; y < 10; y += 1) for (let x = 6; x < 10; x += 1) current[y * 64 + x] = 158;
    expect(
      photoResidualWindowsWithinBounds(
        original,
        current,
        64,
        64,
        1,
        { tileRms: 11.5 },
        () => undefined,
      ),
    ).toBe(false);
  });

  it('keeps maximum byte residuals exact through signed row removal and clipped color windows', () => {
    const original = Uint8Array.from({ length: 65 * 65 * 3 }, (_, index) => (index % 2 ? 255 : 0));
    const current = Uint8Array.from(original, (value) => 255 - value);
    for (const rule of [
      { tileRms: 255, tileMean: 255 },
      { tileRms: 254.999 },
      { tileRms: 255, tileMean: 0 },
    ]) {
      expect(
        photoResidualWindowsWithinBounds(original, current, 65, 65, 3, rule, () => undefined),
      ).toBe(naiveRectangles(original, current, 65, 65, 3, rule));
    }
  });

  it('propagates a deadline refusal before calculating windows', () => {
    const image = new Uint8Array(65 * 65);
    const deadline = new Error('Native residual deadline');
    expect(() =>
      photoResidualWindowsWithinBounds(image, image, 65, 65, 1, { tileRms: 0 }, () => {
        throw deadline;
      }),
    ).toThrow(deadline);
  });

  it('rechecks the deadline after the rolling rows advance', () => {
    const image = new Uint8Array(65 * 65 * 3);
    const deadline = new Error('Native residual deadline after admission');
    let checks = 0;
    expect(() =>
      photoResidualWindowsWithinBounds(image, image, 65, 65, 3, { tileRms: 0 }, () => {
        if (++checks === 4) throw deadline;
      }),
    ).toThrow(deadline);
    expect(checks).toBe(4);
  });
});
