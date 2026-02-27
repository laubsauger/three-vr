export interface ParityMarkerDecodeResult {
  markerId: number;
  confidence: number;
  borderScore: number;
  parityErrorCount: number;
}

interface SampledGrid {
  bits: number[][];
  threshold: number;
}

/**
 * Decode a 6x6 marker with black border and 4x4 parity payload.
 * Payload layout:
 * - data bits at rows 0..2, cols 0..2 (9 bits)
 * - row parity in col 3 of rows 0..2
 * - col parity in row 3 of cols 0..2
 * - overall parity in row 3, col 3
 */
export function decodeParityMarkerFromRegion(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): ParityMarkerDecodeResult | null {
  if (x1 - x0 < 18 || y1 - y0 < 18) {
    return null;
  }

  const sampled = sampleGrid(gray, width, height, x0, y0, x1, y1, 6);
  if (!sampled) {
    return null;
  }

  const borderScore = computeBorderDarkScore(sampled.bits);
  if (borderScore < 0.78) {
    return null;
  }

  let best: ParityMarkerDecodeResult | null = null;
  let candidate = sampled.bits;

  for (let rot = 0; rot < 4; rot++) {
    const payload = extractPayload(candidate);
    const parityErrorCount = countParityErrors(payload);

    if (parityErrorCount <= 1) {
      const markerId = payloadToId(payload);
      const confidence = clamp(0.58 + borderScore * 0.26 - parityErrorCount * 0.18, 0.25, 0.99);
      const result: ParityMarkerDecodeResult = {
        markerId,
        confidence,
        borderScore,
        parityErrorCount
      };

      if (!best || result.confidence > best.confidence) {
        best = result;
      }
    }

    candidate = rotate90(candidate);
  }

  return best;
}

function sampleGrid(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  gridSize: number
): SampledGrid | null {
  const bits: number[][] = [];

  // Local threshold from region mean.
  let regionSum = 0;
  let regionCount = 0;
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      regionSum += gray[y * width + x];
      regionCount++;
    }
  }
  if (regionCount === 0) {
    return null;
  }

  const threshold = regionSum / regionCount;

  for (let gy = 0; gy < gridSize; gy++) {
    const row: number[] = [];
    for (let gx = 0; gx < gridSize; gx++) {
      const sx = x0 + ((gx + 0.5) * (x1 - x0)) / gridSize;
      const sy = y0 + ((gy + 0.5) * (y1 - y0)) / gridSize;
      const value = sampleNeighborhood(gray, width, height, sx, sy);
      row.push(value < threshold ? 1 : 0); // 1 = dark/black
    }
    bits.push(row);
  }

  return {
    bits,
    threshold
  };
}

function sampleNeighborhood(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
): number {
  const cx = Math.floor(clamp(x, 0, width - 1));
  const cy = Math.floor(clamp(y, 0, height - 1));

  let sum = 0;
  let count = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const px = Math.max(0, Math.min(width - 1, cx + ox));
      const py = Math.max(0, Math.min(height - 1, cy + oy));
      sum += gray[py * width + px];
      count++;
    }
  }

  return sum / count;
}

function computeBorderDarkScore(bits: number[][]): number {
  const size = bits.length;
  let dark = 0;
  let total = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
        total++;
        dark += bits[y][x] === 1 ? 1 : 0;
      }
    }
  }

  return total > 0 ? dark / total : 0;
}

function extractPayload(bits: number[][]): number[][] {
  const payload: number[][] = [];
  for (let y = 1; y <= 4; y++) {
    payload.push(bits[y].slice(1, 5));
  }
  return payload;
}

function countParityErrors(payload: number[][]): number {
  let errors = 0;

  for (let r = 0; r < 3; r++) {
    const rowParity = payload[r][0] ^ payload[r][1] ^ payload[r][2];
    if (rowParity !== payload[r][3]) {
      errors++;
    }
  }

  for (let c = 0; c < 3; c++) {
    const colParity = payload[0][c] ^ payload[1][c] ^ payload[2][c];
    if (colParity !== payload[3][c]) {
      errors++;
    }
  }

  const totalParity =
    payload[0][0] ^
    payload[0][1] ^
    payload[0][2] ^
    payload[1][0] ^
    payload[1][1] ^
    payload[1][2] ^
    payload[2][0] ^
    payload[2][1] ^
    payload[2][2];
  if (totalParity !== payload[3][3]) {
    errors++;
  }

  return errors;
}

function payloadToId(payload: number[][]): number {
  let value = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      value = (value << 1) | (payload[r][c] & 1);
    }
  }
  return value;
}

function rotate90(bits: number[][]): number[][] {
  const size = bits.length;
  const rotated: number[][] = Array.from({ length: size }, () => Array(size).fill(0));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      rotated[x][size - 1 - y] = bits[y][x];
    }
  }

  return rotated;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
