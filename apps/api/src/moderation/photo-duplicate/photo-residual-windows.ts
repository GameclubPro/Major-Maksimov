const TILE = 8;
const STRIDE = 4;

export function photoResidualWindowsWithinBounds(
  original: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
  channels: number,
  limits: Readonly<{ tileRms: number; tileMean?: number }>,
  assertTime: () => void,
): boolean {
  // FLAG: Preserve every overlapping full-resolution window and clipped edge.
  // Native callers validate raster lengths and pair limits before this calculation;
  // rolling integer totals stay exact below Number.MAX_SAFE_INTEGER under those limits.
  const columnSums = new Float64Array(width);
  const columnSquares = new Float64Array(width);
  const updateRows = (start: number, end: number, sign: number) => {
    for (let y = start; y < end; y += 1) {
      if (y % 64 === 0) assertTime();
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let square = 0;
        for (let channel = 0; channel < channels; channel += 1) {
          const index = (y * width + x) * channels + channel;
          const difference = original[index]! - current[index]!;
          sum += difference;
          square += difference * difference;
        }
        columnSums[x]! += sign * sum;
        columnSquares[x]! += sign * square;
      }
    }
  };
  updateRows(0, Math.min(TILE, height), 1);
  for (let top = 0; top < height; top += STRIDE) {
    if (top % 64 === 0) assertTime();
    if (top > 0) {
      updateRows(top - STRIDE, top, -1);
      updateRows(Math.min(top - STRIDE + TILE, height), Math.min(top + TILE, height), 1);
    }
    const rows = Math.min(TILE, height - top);
    for (let left = 0; left < width; left += STRIDE) {
      let sum = 0;
      let square = 0;
      const right = Math.min(left + TILE, width);
      for (let x = left; x < right; x += 1) {
        sum += columnSums[x]!;
        square += columnSquares[x]!;
      }
      const count = rows * (right - left) * channels;
      if (
        square > count * limits.tileRms ** 2 ||
        (limits.tileMean !== undefined && Math.abs(sum) > count * limits.tileMean)
      )
        return false;
    }
  }
  return true;
}
