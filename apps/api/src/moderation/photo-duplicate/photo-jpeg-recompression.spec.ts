import sharp from 'sharp';
import { readStandardJpegRecompressionRecipe } from './photo-jpeg-recompression';

type JpegOptions = NonNullable<Parameters<ReturnType<typeof sharp>['jpeg']>[0]>;

function jpeg(options: JpegOptions = {}) {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#458da3' } })
    .jpeg({ quality: 80, ...options })
    .toBuffer();
}

function headerSegments(bytes: Buffer) {
  const segments: { marker: number; start: number; end: number; data: number }[] = [];
  let start = 2;
  while (start + 4 <= bytes.length) {
    const marker = bytes[start + 1]!;
    const end = start + 2 + bytes.readUInt16BE(start + 2);
    segments.push({ marker, start, end, data: start + 4 });
    if (marker === 0xda) break;
    start = end;
  }
  return segments;
}

function segment(bytes: Buffer, marker: number, occurrence = 0) {
  const selected = headerSegments(bytes).filter((value) => value.marker === marker)[occurrence];
  if (!selected) throw new Error('Expected JPEG fixture marker missing');
  return selected;
}

function insert(bytes: Buffer, offset: number, addition: Buffer) {
  return Buffer.concat([bytes.subarray(0, offset), addition, bytes.subarray(offset)]);
}

function comment(totalBytes: number) {
  const value = Buffer.alloc(totalBytes, 0x61);
  value[0] = 0xff;
  value[1] = 0xfe;
  value.writeUInt16BE(totalBytes - 2, 2);
  return value;
}

describe('standard JPEG recompression recipe header', () => {
  const cases = [50, 51, 65, 80, 92, 99, 100].flatMap((quality) =>
    (['4:2:0', '4:4:4'] as const).flatMap((chromaSubsampling) =>
      [false, true].map((progressive) => ({ quality, chromaSubsampling, progressive })),
    ),
  );

  it.each(cases)(
    'reads the complete standard tables at Q$quality, $chromaSubsampling, progressive=$progressive',
    async ({ quality, chromaSubsampling, progressive }) => {
      expect(
        readStandardJpegRecompressionRecipe(
          await jpeg({ quality, chromaSubsampling, progressive }),
        ),
      ).toEqual({ quality, chromaSubsampling });
    },
  );

  it('reads a Uint8Array whose backing buffer starts before the JPEG', async () => {
    const source = await jpeg();
    const wrapped = Buffer.concat([Buffer.alloc(11), source, Buffer.alloc(7)]);
    const view = new Uint8Array(wrapped.buffer, wrapped.byteOffset + 11, source.length);
    expect(readStandardJpegRecompressionRecipe(view)).toEqual({
      quality: 80,
      chromaSubsampling: '4:2:0',
    });
  });

  it('accepts both standard tables in one DQT segment', async () => {
    const source = await jpeg();
    const first = segment(source, 0xdb);
    const second = segment(source, 0xdb, 1);
    const payload = Buffer.concat([
      source.subarray(first.data, first.end),
      source.subarray(second.data, second.end),
    ]);
    const combined = Buffer.alloc(payload.length + 4);
    combined[0] = 0xff;
    combined[1] = 0xdb;
    combined.writeUInt16BE(payload.length + 2, 2);
    payload.copy(combined, 4);
    const withCombinedTables = Buffer.concat([
      source.subarray(0, first.start),
      combined,
      source.subarray(first.end, second.start),
      source.subarray(second.end),
    ]);
    expect(readStandardJpegRecompressionRecipe(withCombinedTables)).toEqual({
      quality: 80,
      chromaSubsampling: '4:2:0',
    });
  });

  it('rejects every incomplete prefix of the complete header', async () => {
    const source = await jpeg();
    const { end } = segment(source, 0xda);
    for (let length = 0; length < end; length += 1)
      expect(readStandardJpegRecompressionRecipe(source.subarray(0, length))).toBeUndefined();
  });

  it.each([1, 25, 49])('does not infer a standard quality below the floor: %i', async (quality) => {
    expect(readStandardJpegRecompressionRecipe(await jpeg({ quality }))).toBeUndefined();
  });

  it('rejects a nonstandard quantization table even at the same nominal quality', async () => {
    expect(
      readStandardJpegRecompressionRecipe(await jpeg({ quantisationTable: 1 })),
    ).toBeUndefined();
  });

  it.each<[string, number, number]>([
    ['one changed coefficient', 1, 1],
    ['zero quantizer', 1, 0],
    ['sixteen-bit quantizers', 0, 0x10],
    ['unsupported table identifier', 0, 2],
  ])('rejects %s', async (_name, relativeOffset, replacement) => {
    const source = await jpeg();
    source[segment(source, 0xdb).data + relativeOffset] = replacement;
    expect(readStandardJpegRecompressionRecipe(source)).toBeUndefined();
  });

  it('requires both tables to describe the same complete standard quality', async () => {
    const source = await jpeg({ quality: 80 });
    const other = await jpeg({ quality: 65 });
    const currentChroma = segment(source, 0xdb, 1);
    const otherChroma = segment(other, 0xdb, 1);
    other.copy(source, currentChroma.data + 1, otherChroma.data + 1, otherChroma.end);
    expect(readStandardJpegRecompressionRecipe(source)).toBeUndefined();
  });

  it('rejects a missing or repeated quantization table', async () => {
    const source = await jpeg();
    const first = segment(source, 0xdb);
    const second = segment(source, 0xdb, 1);
    expect(
      readStandardJpegRecompressionRecipe(
        Buffer.concat([source.subarray(0, second.start), source.subarray(second.end)]),
      ),
    ).toBeUndefined();
    expect(
      readStandardJpegRecompressionRecipe(
        insert(source, segment(source, 0xda).start, source.subarray(first.start, first.end)),
      ),
    ).toBeUndefined();
  });

  it('rejects a repeated frame instead of choosing one interpretation', async () => {
    const source = await jpeg();
    const frame = segment(source, 0xc0);
    expect(
      readStandardJpegRecompressionRecipe(
        insert(source, segment(source, 0xda).start, source.subarray(frame.start, frame.end)),
      ),
    ).toBeUndefined();
  });

  it.each<[string, number, number]>([
    ['twelve-bit samples', 0, 12],
    ['missing dimensions', 2, 0],
    ['one component', 5, 1],
    ['unknown component identifier', 6, 4],
    ['4:2:2 sampling', 7, 0x21],
    ['4:4:0 sampling', 7, 0x12],
    ['unsupported Y table', 8, 1],
    ['subsampled chroma', 10, 0x22],
    ['unsupported chroma table', 11, 0],
  ])('rejects %s from the SOF fields', async (_name, relativeOffset, replacement) => {
    const source = await jpeg();
    source[segment(source, 0xc0).data + relativeOffset] = replacement;
    expect(readStandardJpegRecompressionRecipe(source)).toBeUndefined();
  });

  it('rejects grayscale and CMYK encodings', async () => {
    const input = sharp({ create: { width: 64, height: 48, channels: 3, background: '#458da3' } });
    expect(
      readStandardJpegRecompressionRecipe(
        await input.clone().greyscale().toColourspace('b-w').jpeg().toBuffer(),
      ),
    ).toBeUndefined();
    expect(
      readStandardJpegRecompressionRecipe(
        await input.clone().toColourspace('cmyk').jpeg().toBuffer(),
      ),
    ).toBeUndefined();
  });

  it.each([0, 1, 65_535])('rejects corrupt marker lengths: %i', async (length) => {
    const source = await jpeg();
    source.writeUInt16BE(length, segment(source, 0xdb).start + 2);
    expect(readStandardJpegRecompressionRecipe(source)).toBeUndefined();
  });

  it('rejects malformed Huffman and scan headers', async () => {
    const source = await jpeg();
    const invalidHuffman = Buffer.from(source);
    invalidHuffman[segment(source, 0xc4).data] = 0x20;
    expect(readStandardJpegRecompressionRecipe(invalidHuffman)).toBeUndefined();
    const invalidScan = Buffer.from(source);
    invalidScan[segment(source, 0xda).data + 3] = 1;
    expect(readStandardJpegRecompressionRecipe(invalidScan)).toBeUndefined();
  });

  it.each([0x00, 0x01, 0xc1, 0xc3, 0xcc, 0xd0, 0xd8, 0xd9])(
    'refuses unsupported marker 0x%s before the image scan',
    async (marker) => {
      const source = await jpeg();
      source[segment(source, 0xc0).start + 1] = marker;
      expect(readStandardJpegRecompressionRecipe(source)).toBeUndefined();
    },
  );

  it('accepts ordinary bounded metadata and refuses a header past 64 KiB', async () => {
    const source = await jpeg();
    const headerEnd = segment(source, 0xda).end;
    const atLimit = insert(source, 2, comment(65_536 - headerEnd));
    expect(readStandardJpegRecompressionRecipe(atLimit)).toEqual({
      quality: 80,
      chromaSubsampling: '4:2:0',
    });
    const pastLimit = insert(source, 2, comment(65_537 - headerEnd));
    expect(readStandardJpegRecompressionRecipe(pastLimit)).toBeUndefined();
  });

  it('bounds marker count independently of the byte limit', async () => {
    const source = await jpeg();
    const markerCount = headerSegments(source).length;
    const padding = Buffer.concat(Array.from({ length: 64 - markerCount }, () => comment(4)));
    expect(readStandardJpegRecompressionRecipe(insert(source, 2, padding))).toEqual({
      quality: 80,
      chromaSubsampling: '4:2:0',
    });
    expect(
      readStandardJpegRecompressionRecipe(insert(source, 2, Buffer.concat([padding, comment(4)]))),
    ).toBeUndefined();
  });

  it('rejects an unbounded run of marker fill bytes', () => {
    const source = Buffer.alloc(65_537, 0xff);
    source[1] = 0xd8;
    expect(readStandardJpegRecompressionRecipe(source)).toBeUndefined();
  });
});
