// Flatbed — tiny, dependency-free image pipeline.
// Everything here runs on the main thread in plain JS; quality matters more than micro-speed.

export type Pt = { x: number; y: number };

/* ---------- helpers ---------- */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function toGray(src: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
  }
  return out;
}

/** Summed-area table, (w+1)*(h+1), float64 for accuracy. */
function integral(g: Float32Array, w: number, h: number): Float64Array {
  const s = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += g[y * w + x];
      s[(y + 1) * (w + 1) + (x + 1)] = s[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return s;
}

function boxMean(s: Float64Array, w: number, x0: number, y0: number, x1: number, y1: number) {
  const W = w + 1;
  const a = s[y0 * W + x0];
  const b = s[y0 * W + x1];
  const c = s[y1 * W + x0];
  const d = s[y1 * W + x1];
  const area = (x1 - x0) * (y1 - y0) || 1;
  return (d - b - c + a) / area;
}

/** Downscale using area-ish sampling; good enough for detection. */
export function downscaleG(img: ImageData, maxSide: number): { g: Float32Array; w: number; h: number; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const gray = toGray(img.data, img.width, img.height);
  const out = new Float32Array(w * h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let acc = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const base = yy * img.width;
        for (let xx = x0; xx < x1; xx++) {
          acc += gray[base + xx];
          n++;
        }
      }
      out[y * w + x] = acc / n;
    }
  }
  return { g: out, w, h, scale };
}

function otsu(g: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[clamp(Math.round(g[i]), 0, 255)]++;
  const total = g.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/* ---------- page detection ---------- */

export type Quad = [Pt, Pt, Pt, Pt]; // TL, TR, BR, BL

/** Separable grayscale morphology on a 0/1 mask. */
function morphPass(src: Uint8Array, w: number, h: number, r: number, mode: "max" | "min"): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const pick = mode === "max" ? Math.max : Math.min;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x];
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let xx = x0; xx <= x1; xx++) v = pick(v, src[row + xx]);
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) v = pick(v, tmp[yy * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

function morphClose(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morphPass(morphPass(morphPass(mask, w, h, r, "max"), w, h, r, "min"), w, h, r, "max");
}

/** Convex hull (monotone chain) of a point list. */
function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const p = pts.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Smallest-area enclosing rectangle of a convex hull, via rotating calipers. */
function minAreaRect(hull: Pt[]): Quad | null {
  if (hull.length < 3) return null;
  let best: { area: number; quad: Quad } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    // orthonormal frame: u along the edge, n perpendicular to it
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const nx = -uy;
    const ny = ux;
    let minT = Infinity;
    let maxT = -Infinity;
    let minS = Infinity;
    let maxS = -Infinity;
    for (const p of hull) {
      const t = p.x * ux + p.y * uy;
      const s = p.x * nx + p.y * ny;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
    }
    const area = (maxT - minT) * (maxS - minS);
    if (!best || area < best.area) {
      const at = (t: number, s: number): Pt => ({ x: t * ux + s * nx, y: t * uy + s * ny });
      best = {
        area,
        quad: [at(minT, minS), at(maxT, minS), at(maxT, maxS), at(minT, maxS)],
      };
    }
  }
  return best ? best.quad : null;
}

/** Order corners as TL, TR, BR, BL and make sure winding is consistent. */
function orderQuad(quad: Quad): Quad {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = quad
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  let bestSum = Infinity;
  sorted.forEach((p, i) => {
    const s = p.x + p.y;
    if (s < bestSum) {
      bestSum = s;
      start = i;
    }
  });
  const out = [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
  // clockwise on screen? cross product of first edges must be positive for TL->TR->BR
  const cross =
    (out[1].x - out[0].x) * (out[2].y - out[1].y) - (out[1].y - out[0].y) * (out[2].x - out[1].x);
  return (cross >= 0 ? out : [out[0], out[3], out[2], out[1]]) as Quad;
}

/**
 * Find the sheet of paper and return its four corners.
 *
 * Paper is bright *and* nearly neutral in colour, which is what separates it
 * from a wooden desk, a hand, or a dark table — the usual failure modes of a
 * naive brightness threshold.
 */
export function detectPageQuad(img: ImageData): Quad | null {
  const { g, w, h } = downscaleG(img, 480);
  const n = w * h;

  // paperness map: bright, low-chroma, and with red barely above blue. That
  // last term is what keeps warm wood and warm highlights out of the mask.
  const chroma = new Float32Array(n);
  const warmth = new Float32Array(n);
  {
    const sx = img.width / w;
    const sy = img.height / h;
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const yy = Math.min(img.height - 1, Math.floor(y * sy));
      for (let x = 0; x < w; x++) {
        const xx = Math.min(img.width - 1, Math.floor(x * sx));
        const i = (yy * img.width + xx) * 4;
        const r = d[i];
        const gg = d[i + 1];
        const b = d[i + 2];
        chroma[y * w + x] = Math.max(r, gg, b) - Math.min(r, gg, b);
        warmth[y * w + x] = r - b;
      }
    }
  }

  const thr = Math.max(otsu(g) * 0.96, 105);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = g[i] > thr && chroma[i] < 60 && warmth[i] < 26 ? 1 : 0;

  // Morphological closing with a separable max/min filter. Print and ruled
  // lines punch holes into the sheet; without this the page is not one blob.
  const closed = morphClose(mask, w, h, Math.max(3, Math.round(Math.min(w, h) * 0.012)));

  // label components (4-connectivity)
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const minArea = n * 0.04;
  const candidates: { pts: number[]; area: number }[] = [];

  for (let start = 0; start < n; start++) {
    if (!closed[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pts: number[] = [];
    while (stack.length) {
      const p = stack.pop()!;
      pts.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && closed[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && closed[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && closed[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && closed[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    if (pts.length >= minArea) candidates.push({ pts, area: pts.length });
  }
  if (!candidates.length) return null;

  // A sheet of paper is a rectangle seen at an angle: score candidates by how
  // completely their minimum-area rectangle is filled. Bright desk patches and
  // merged blobs score badly, a clean page scores ~0.9 and up.
  let bestQuad: Quad | null = null;
  let bestScore = 0;
  const inv = img.width / w;

  for (const cand of candidates) {
    const step = Math.max(1, Math.floor(cand.pts.length / 5000));
    const cloud: Pt[] = [];
    for (let i = 0; i < cand.pts.length; i += step) {
      const p = cand.pts[i];
      const x = p % w;
      cloud.push({ x, y: (p - x) / w });
    }
    const rect = minAreaRect(convexHull(cloud));
    if (!rect) continue;

    const area = Math.abs(
      (rect[1].x - rect[0].x) * (rect[1].y + rect[0].y) / 2 +
        (rect[2].x - rect[1].x) * (rect[2].y + rect[1].y) / 2 +
        (rect[3].x - rect[2].x) * (rect[3].y + rect[2].y) / 2 +
        (rect[0].x - rect[3].x) * (rect[0].y + rect[3].y) / 2
    );
    if (area < 1) continue;

    const fill = cand.area / area;
    const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
    const long = Math.max(d(rect[0], rect[1]), d(rect[1], rect[2]));
    const short = Math.min(d(rect[0], rect[1]), d(rect[1], rect[2]));
    const aspect = long / short;
    if (aspect < 0.45 || aspect > 2.4) continue;
    if (short < Math.min(w, h) * 0.2) continue;

    // prefer well-filled rectangles; break ties with bigger area
    const score = fill + Math.min(cand.area / n, 0.5) * 0.2;
    if (fill > 0.72 && score > bestScore) {
      bestScore = score;
      bestQuad = rect;
    }
  }

  if (!bestQuad) return null;
  // the closing step grows the mask by a pixel or two, so pull the frame back in
  // slightly: better a hair of white margin than a dark edge baked into the scan
  const cx = bestQuad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = bestQuad.reduce((s, p) => s + p.y, 0) / 4;
  const inset = 0.994;
  const tightened = bestQuad.map((p) => ({
    x: cx + (p.x - cx) * inset,
    y: cy + (p.y - cy) * inset,
  }));
  const coarse = orderQuad(tightened as Quad);

  // second pass: snap the four sides onto the actual paper boundary
  const grad = sobelMagnitude(g, w, h);
  const window = Math.max(6, Math.min(w, h) * 0.05);
  let refined: Quad = coarse;
  for (let pass = 0; pass < 3; pass++) {
    refined = refineQuadByEdges(refined, g, grad, w, h, window);
  }

  // keep the paper edge itself out of the crop: a hair of white margin reads as
  // "scanned", a dark 1px rim reads as "photo"
  const fx = refined.reduce((sum, p) => sum + p.x, 0) / 4;
  const fy = refined.reduce((sum, p) => sum + p.y, 0) / 4;
  const shrink = 1 - 2.2 / Math.max(40, Math.min(w, h));
  const trimmed = refined.map((p) => ({
    x: fx + (p.x - fx) * shrink,
    y: fy + (p.y - fy) * shrink,
  })) as Quad;

  return orderQuad(trimmed.map((p) => ({ x: p.x * inv, y: p.y * inv })) as Quad);
}

function sobelMagnitude(g: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = g[i - w - 1];
      const tc = g[i - w];
      const tr = g[i - w + 1];
      const ml = g[i - 1];
      const mr = g[i + 1];
      const bl = g[i + w - 1];
      const bc = g[i + w];
      const br = g[i + w + 1];
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      out[i] = Math.hypot(gx, gy) / 4;
    }
  }
  return out;
}

function sampleBilinear(buf: Float32Array, w: number, h: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return (
    buf[i] * (1 - fx) * (1 - fy) +
    buf[i + 1] * fx * (1 - fy) +
    buf[i + w] * (1 - fx) * fy +
    buf[i + w + 1] * fx * fy
  );
}

/**
 * Snap the four sides of the coarse quad onto the sheet edge.
 *
 * Each side is slid along its normal within a small window while measuring two
 * things: edge strength (paper vs. desk is the strongest edge nearby) and
 * polarity (the sheet is brighter than what surrounds it). Lines keep the
 * coarse orientation, so corners stay sane even where an edge is occluded.
 */
function refineQuadByEdges(
  quad: Quad,
  g: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  window: number
): Quad {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const samples = 24;
  const probe = Math.max(2, Math.round(Math.min(w, h) * 0.012));

  const sides: { a: Pt; b: Pt; nx: number; ny: number; offset: number; tilt: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    if ((a.x + b.x) / 2 - cx >= 0 ? nx < 0 : nx > 0) {
      nx = -nx;
      ny = -ny;
    } else if (Math.abs((a.x + b.x) / 2 - cx) < 1e-6 && (a.y + b.y) / 2 - cy >= 0 && ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    sides.push({ a, b, nx, ny, offset: 0, tilt: 0 });
  }

  // Per side, search a line "offset + tilt" instead of a constant offset: a
  // photographed sheet is a trapezoid, so the true edge is not parallel to the
  // coarse rectangle.
  for (const side of sides) {
    const evaluate = (o0: number, o1: number) => {
      let edge = 0;
      let polarity = 0;
      let used = 0;
      for (let k = 1; k < samples; k++) {
        const t = 0.08 + (0.84 * k) / (samples - 1);
        const off = o0 + o1 * (t - 0.5);
        const px = side.a.x + (side.b.x - side.a.x) * t + side.nx * off;
        const py = side.a.y + (side.b.y - side.a.y) * t + side.ny * off;
        if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue;
        const strength = sampleBilinear(grad, w, h, px, py);
        const outside = sampleBilinear(g, w, h, px + side.nx * probe, py + side.ny * probe);
        const inside = sampleBilinear(g, w, h, px - side.nx * probe, py - side.ny * probe);
        const contrast = inside - outside;
        const signed = contrast > 4 ? Math.min(1, contrast / 34) : 0;
        edge += strength;
        polarity += signed;
        used++;
      }
      if (!used) return -Infinity;
      return (edge / used) * (polarity / used) - (Math.abs(o0) + Math.abs(o1) * 0.5) * 0.4;
    };

    let best = { o0: 0, o1: 0, score: evaluate(0, 0) };
    // a photographed sheet is a trapezoid, so the tilt range must be wider
    // than the offset range: that is what corrects the perspective sides
    const coarseStep = Math.max(2, window / 3);
    const tiltRange = window * 2.5;
    for (let o0 = -window; o0 <= window; o0 += coarseStep) {
      for (let o1 = -tiltRange; o1 <= tiltRange; o1 += coarseStep) {
        const sc = evaluate(o0, o1);
        if (sc > best.score) best = { o0, o1, score: sc };
      }
    }
    for (const step of [1.5, 0.75, 0.4]) {
      let improved = true;
      while (improved) {
        improved = false;
        for (const [d0, d1] of [
          [step, 0],
          [-step, 0],
          [0, step],
          [0, -step],
        ]) {
          const sc = evaluate(best.o0 + d0, best.o1 + d1);
          if (sc > best.score + 1e-6) {
            best = { o0: best.o0 + d0, o1: best.o1 + d1, score: sc };
            improved = true;
            break;
          }
        }
      }
    }
    side.offset = best.o0;
    side.tilt = best.o1;
  }

  // intersect neighbouring offset lines
  // offset at the start and at the end of the side (tilt tilts the line)
  const lineOf = (s: { a: Pt; b: Pt; nx: number; ny: number; offset: number; tilt: number }) => {
    const p0 = {
      x: s.a.x + s.nx * (s.offset - s.tilt / 2),
      y: s.a.y + s.ny * (s.offset - s.tilt / 2),
    };
    const p1 = {
      x: s.b.x + s.nx * (s.offset + s.tilt / 2),
      y: s.b.y + s.ny * (s.offset + s.tilt / 2),
    };
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    return { a: -dy / len, b: dx / len, c: (dy * p0.x - dx * p0.y) / len };
  };
  const lines = sides.map(lineOf);
  const corners: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const p = intersectLines(lines[(i + 3) % 4], lines[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > -8 && p.y > -8 && p.x < w + 8 && p.y < h + 8) {
      corners.push({ x: Math.max(0, Math.min(w - 1, p.x)), y: Math.max(0, Math.min(h - 1, p.y)) });
    } else {
      corners.push(quad[i]);
    }
  }
  return orderQuad(corners as Quad);
}

function intersectLines(l1: { a: number; b: number; c: number }, l2: { a: number; b: number; c: number }): Pt | null {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (l1.b * l2.c - l2.b * l1.c) / det, y: (l2.a * l1.c - l1.a * l2.c) / det };
}

export function fullFrameQuad(w: number, h: number, inset = 0.02): Quad {
  const dx = w * inset;
  const dy = h * inset;
  return [
    { x: dx, y: dy },
    { x: w - dx, y: dy },
    { x: w - dx, y: h - dy },
    { x: dx, y: h - dy },
  ];
}

/* ---------- perspective transform ---------- */

/** Solve 8x8 linear system (Gaussian elimination with partial pivoting). */
function solve8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      [A[piv], A[col]] = [A[col], A[piv]];
      [b[piv], b[col]] = [b[col], b[piv]];
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

/** Homography that maps destination rect (0..w, 0..h) onto the source quad. */
function homographyDstToSrc(quad: Quad, w: number, h: number): Float64Array | null {
  const dst: Pt[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: u, y: v } = quad[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const s = solve8(A, b);
  if (!s) return null;
  return new Float64Array([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1]);
}

function bilinear(data: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: number[], o: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx0 = clamp(x0, 0, w - 1);
  const cx1 = clamp(x0 + 1, 0, w - 1);
  const cy0 = clamp(y0, 0, h - 1);
  const cy1 = clamp(y0 + 1, 0, h - 1);
  const i00 = (cy0 * w + cx0) * 4;
  const i10 = (cy0 * w + cx1) * 4;
  const i01 = (cy1 * w + cx0) * 4;
  const i11 = (cy1 * w + cx1) * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  for (let c = 0; c < 3; c++) {
    out[o + c] =
      data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  }
  out[o + 3] = 255;
}

export function outputSize(quad: Quad, maxSide = 2600): { w: number; h: number } {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const wTop = d(quad[0], quad[1]);
  const wBot = d(quad[3], quad[2]);
  const hLeft = d(quad[0], quad[3]);
  const hRight = d(quad[1], quad[2]);
  let w = Math.round(Math.max(wTop, wBot));
  let h = Math.round(Math.max(hLeft, hRight));
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(64, Math.round(w * s)), h: Math.max(64, Math.round(h * s)) };
}

export function warp(img: ImageData, quad: Quad, w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  const M = homographyDstToSrc(quad, w, h);
  if (!M) return out;
  const tmp = new Array<number>(4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const den = M[6] * x + M[7] * y + M[8];
      const u = (M[0] * x + M[1] * y + M[2]) / den;
      const v = (M[3] * x + M[4] * y + M[5]) / den;
      bilinear(img.data, img.width, img.height, u, v, tmp, 0);
      const o = (y * w + x) * 4;
      out.data[o] = tmp[0];
      out.data[o + 1] = tmp[1];
      out.data[o + 2] = tmp[2];
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/* ---------- enhancement ---------- */

export type Mode = "bw" | "gray" | "color";

export type EnhanceOpts = {
  mode: Mode;
  brightness: number; // -50..50
  contrast: number; // -50..50
  /** 0..100, only for bw: how aggressive the adaptive threshold is */
  strength?: number;
};

/** Robust contrast stretch using percentiles, then brightness/contrast curve. */
function applyLevels(v: number, lo: number, hi: number, brightness: number, contrast: number) {
  const t = clamp((v - lo) / Math.max(1, hi - lo), 0, 1);
  const c = (contrast / 50) * 0.5; // -0.5..0.5
  let x = t + (t - 0.5) * c * 2;
  x += brightness / 200;
  return clamp(x, 0, 1) * 255;
}

export function enhance(src: ImageData, opts: EnhanceOpts): ImageData {
  const { width: w, height: h } = src;
  const gray = toGray(src.data, w, h);
  const out = new ImageData(w, h);
  const o = out.data;
  const brightness = opts.brightness ?? 0;
  const contrast = opts.contrast ?? 0;

  if (opts.mode === "bw") {
    const s1 = integral(gray, w, h);
    const sq = new Float32Array(w * h);
    for (let i = 0; i < sq.length; i++) sq[i] = gray[i] * gray[i];
    const s2 = integral(sq, w, h);
    const r = Math.max(6, Math.round(Math.min(w, h) / 26));
    // Sauvola: t = m * (1 + k * (s/R - 1)); k scales with the strength slider
    const k = 0.06 + ((opts.strength ?? 55) / 100) * 0.42;
    const R = 128;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w, x + r + 1);
        const m = boxMean(s1, w, x0, y0, x1, y1);
        const m2 = boxMean(s2, w, x0, y0, x1, y1);
        const dev = Math.sqrt(Math.max(0, m2 - m * m));
        const t = m * (1 + k * (dev / R - 1));
        const g = gray[y * w + x];
        const isInk = g < t;
        // keep a hint of anti-aliasing so text doesn't look like pixel vomit
        let val = isInk ? 0 : 255;
        if (Math.abs(g - t) < 12 && !isInk) val = 232;
        const idx = (y * w + x) * 4;
        o[idx] = val;
        o[idx + 1] = val;
        o[idx + 2] = val;
        o[idx + 3] = 255;
      }
    }
    return out;
  }

  // percentile stretch (2%..98%) on the grayscale histogram
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[clamp(Math.round(gray[i]), 0, 255)]++;
  let lo = 0;
  let hi = 255;
  let acc = 0;
  const cut = gray.length * 0.02;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc > cut) { lo = v; break; }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc > cut) { hi = v; break; }
  }
  if (hi - lo < 24) { lo = 0; hi = 255; }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const idx = i * 4;
      if (opts.mode === "gray") {
        const v = applyLevels(gray[i], lo, hi, brightness, contrast);
        o[idx] = v;
        o[idx + 1] = v;
        o[idx + 2] = v;
      } else {
        // color: stretch each channel around the gray levels, gentle saturation
        const g = applyLevels(gray[i], lo, hi, brightness, contrast) - gray[i];
        o[idx] = clamp(src.data[idx] + g, 0, 255);
        o[idx + 1] = clamp(src.data[idx + 1] + g, 0, 255);
        o[idx + 2] = clamp(src.data[idx + 2] + g, 0, 255);
      }
      o[idx + 3] = 255;
    }
  }
  return out;
}
