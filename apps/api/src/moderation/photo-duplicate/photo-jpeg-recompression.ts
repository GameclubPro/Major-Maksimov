export type StandardJpegRecompressionRecipe = Readonly<{
  quality: number;
  chromaSubsampling: '4:2:0' | '4:4:4';
}>;

const MAX_JPEG_HEADER_BYTES = 65_536;
const MAX_JPEG_HEADER_MARKERS = 64;

// FLAG: These are the Annex K tables used by libjpeg's standard quality recipe.
// A complete exact match selects one encode; an estimated quality never does.
const STANDARD_LUMINANCE_TABLE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
] as const;
const STANDARD_CHROMINANCE_TABLE = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
] as const;
const JPEG_ZIGZAG_TO_NATURAL = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
] as const;

type StandardJpegFrame = Readonly<{
  progressive: boolean;
  chromaSubsampling: StandardJpegRecompressionRecipe['chromaSubsampling'];
}>;

function readStandardFrame(
  bytes: Uint8Array,
  start: number,
  end: number,
  progressive: boolean,
): StandardJpegFrame | undefined {
  if (
    end - start !== 15 ||
    bytes[start] !== 8 ||
    (bytes[start + 1] === 0 && bytes[start + 2] === 0) ||
    (bytes[start + 3] === 0 && bytes[start + 4] === 0) ||
    bytes[start + 5] !== 3 ||
    bytes[start + 6] !== 1 ||
    bytes[start + 8] !== 0 ||
    bytes[start + 9] !== 2 ||
    bytes[start + 10] !== 0x11 ||
    bytes[start + 11] !== 1 ||
    bytes[start + 12] !== 3 ||
    bytes[start + 13] !== 0x11 ||
    bytes[start + 14] !== 1
  )
    return undefined;
  // FLAG: libvips metadata calls any subsampling "4:2:0", including 4:2:2.
  // Inspect the actual SOF factors instead of trusting that lossy summary.
  const sampling = bytes[start + 7];
  if (sampling !== 0x22 && sampling !== 0x11) return undefined;
  return { progressive, chromaSubsampling: sampling === 0x22 ? '4:2:0' : '4:4:4' };
}

function validFirstScan(
  bytes: Uint8Array,
  start: number,
  end: number,
  frame: StandardJpegFrame,
): boolean {
  const components = bytes[start];
  if (!components || components > 3 || end - start !== 4 + components * 2) return false;
  if (!frame.progressive && components !== 3) return false;
  const seen = new Set<number>();
  for (let index = 0; index < components; index += 1) {
    const id = bytes[start + 1 + index * 2]!;
    const tables = bytes[start + 2 + index * 2]!;
    if (id < 1 || id > 3 || seen.has(id) || tables >> 4 > 1 || (tables & 15) > 1) return false;
    seen.add(id);
  }
  const spectralStart = bytes[end - 3];
  const spectralEnd = bytes[end - 2];
  const approximation = bytes[end - 1]!;
  return frame.progressive
    ? spectralStart === 0 && spectralEnd === 0 && approximation <= 13
    : spectralStart === 0 && spectralEnd === 63 && approximation === 0;
}

function validHuffmanSegment(bytes: Uint8Array, start: number, end: number): boolean {
  let offset = start;
  while (offset < end) {
    if (offset + 17 > end) return false;
    const table = bytes[offset]!;
    if (table >> 4 > 1 || (table & 15) > 3) return false;
    let symbols = 0;
    for (let index = 1; index <= 16; index += 1) symbols += bytes[offset + index]!;
    if (!symbols || symbols > 256) return false;
    offset += 17 + symbols;
    if (offset > end) return false;
  }
  return offset > start;
}

function findStandardQuality(luminance: Uint8Array, chrominance: Uint8Array): number | undefined {
  for (let quality = 50; quality <= 100; quality += 1) {
    const scale = 200 - quality * 2;
    let matched = true;
    for (let index = 0; index < 64; index += 1) {
      const natural = JPEG_ZIGZAG_TO_NATURAL[index]!;
      const expectedLuminance = Math.max(
        1,
        Math.floor((STANDARD_LUMINANCE_TABLE[natural]! * scale + 50) / 100),
      );
      const expectedChrominance = Math.max(
        1,
        Math.floor((STANDARD_CHROMINANCE_TABLE[natural]! * scale + 50) / 100),
      );
      if (luminance[index] !== expectedLuminance || chrominance[index] !== expectedChrominance) {
        matched = false;
        break;
      }
    }
    if (matched) return quality;
  }
  return undefined;
}

// FLAG: This bounded header reader selects a recipe, never establishes image equality.
// Entropy decoding and exact full canonical RGBA verification belong to the native caller.
export function readStandardJpegRecompressionRecipe(
  bytes: Uint8Array,
): StandardJpegRecompressionRecipe | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const headerLimit = Math.min(bytes.length, MAX_JPEG_HEADER_BYTES);
  const tables: (Uint8Array | undefined)[] = [undefined, undefined];
  let frame: StandardJpegFrame | undefined;
  let offset = 2;
  let markers = 0;
  while (offset < headerLimit && markers < MAX_JPEG_HEADER_MARKERS) {
    if (bytes[offset++] !== 0xff) return undefined;
    while (offset < headerLimit && bytes[offset] === 0xff) offset += 1;
    if (offset >= headerLimit) return undefined;
    const marker = bytes[offset++]!;
    markers += 1;
    if (offset + 2 > headerLimit) return undefined;
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || length > headerLimit - offset) return undefined;
    const start = offset + 2;
    const end = offset + length;
    if (marker === 0xdb) {
      if (start === end) return undefined;
      for (let cursor = start; cursor < end; cursor += 65) {
        const table = bytes[cursor]!;
        if (cursor + 65 > end || (table !== 0 && table !== 1) || tables[table]) return undefined;
        tables[table] = bytes.subarray(cursor + 1, cursor + 65);
      }
    } else if (marker === 0xc0 || marker === 0xc2) {
      if (frame) return undefined;
      frame = readStandardFrame(bytes, start, end, marker === 0xc2);
      if (!frame) return undefined;
    } else if (marker === 0xda) {
      if (!frame || !tables[0] || !tables[1] || !validFirstScan(bytes, start, end, frame))
        return undefined;
      const quality = findStandardQuality(tables[0], tables[1]);
      return quality === undefined
        ? undefined
        : { quality, chromaSubsampling: frame.chromaSubsampling };
    } else if (marker === 0xc4) {
      if (!validHuffmanSegment(bytes, start, end)) return undefined;
    } else if (marker === 0xdd) {
      if (end - start !== 2) return undefined;
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
      return undefined;
    }
    offset = end;
  }
  return undefined;
}
