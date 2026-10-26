/**
 * Synthetic photos of a document on a desk.
 *
 * Real photographs are hard to assert against; these scenes have known corners,
 * so detection can be checked for accuracy instead of just "something happened".
 */

export type Pt = { x: number; y: number };

export type SceneOptions = {
  width?: number;
  height?: number;
  /** Paper corners, clockwise from the top-left. */
  corners: [Pt, Pt, Pt, Pt];
  /** Luma of the paper and of the desk, 0..255. */
  paper?: number;
  desk?: number;
  /** Warmth of the desk: red minus blue. Wood is warm, screens are not. */
  deskWarmth?: number;
  /** Print on the page, as a share of the page height. */
  text?: boolean;
  /** Deterministic noise amplitude. */
  noise?: number;
  /** Soft shading across the paper, like a shadow or a lamp. */
  shading?: number;
};

class Data {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}

/** Deterministic pseudo-random in [-1, 1]. */
function noiseAt(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

function inside(px: number, py: number, quad: [Pt, Pt, Pt, Pt]): boolean {
  let result = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = quad[i];
    const b = quad[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      result = !result;
    }
  }
  return result;
}

export function renderScene(options: SceneOptions): ImageData {
  const {
    width = 900,
    height = 700,
    corners,
    paper = 226,
    desk = 96,
    deskWarmth = 34,
    text = true,
    noise = 4,
    shading = 10,
  } = options;

  const img = new Data(width, height);

  // desk: grey with a warm tint, plus fine grain
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = noiseAt(x, y) * noise;
      const base = desk + n + Math.sin(x * 0.004) * 3;
      const i = (y * width + x) * 4;
      img.data[i] = base + deskWarmth;
      img.data[i + 1] = base + deskWarmth * 0.55;
      img.data[i + 2] = base;
      img.data[i + 3] = 255;
    }
  }

  // page: slightly shaded, neutral, with print
  const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
  const top = Math.min(...corners.map((p) => p.y));
  const bottom = Math.max(...corners.map((p) => p.y));

  for (let y = Math.max(0, Math.floor(top) - 2); y < Math.min(height, Math.ceil(bottom) + 2); y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x + 0.5, y + 0.5, corners)) continue;
      const n = noiseAt(x, y) * noise * 0.6;
      // soft horizontal gradient + a shadow towards the bottom
      const shade = shading * ((x - cx) / width) - shading * 0.6 * ((y - top) / Math.max(1, bottom - top));
      let v = paper + n - shade;
      if (text) {
        const rel = (y - top) / Math.max(1, bottom - top);
        const line = Math.floor(rel * 26);
        const inLine = rel * 26 - line < 0.42 && line % 3 !== 2;
        if (inLine && x % 7 !== 0) v -= 96;
      }
      const i = (y * width + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }

  return img as unknown as ImageData;
}

/** Mean distance between two quads, in pixels. */
export function quadError(a: [Pt, Pt, Pt, Pt], b: [Pt, Pt, Pt, Pt]): number {
  return (
    a.reduce((sum, p, i) => sum + Math.hypot(p.x - b[i].x, p.y - b[i].y), 0) / a.length
  );
}

/** Rotate a rectangle around its centre, for a "held by hand" look. */
export function rotatedRect(
  cx: number,
  cy: number,
  w: number,
  h: number,
  degrees: number
): [Pt, Pt, Pt, Pt] {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corner = (dx: number, dy: number): Pt => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  });
  return [
    corner(-w / 2, -h / 2),
    corner(w / 2, -h / 2),
    corner(w / 2, h / 2),
    corner(-w / 2, h / 2),
  ];
}
