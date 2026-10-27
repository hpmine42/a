// Scano — tiny, dependency-free image pipeline.
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
/** Luma percentile, for thresholds that survive a mostly-white scene. */
function percentile(g: Float32Array, p: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[clamp(Math.round(g[i]), 0, 255)]++;
  const target = g.length * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

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

export type DetectEffort = "fast" | "thorough";
export type DetectOptions = {
  /** `fast` is for the live viewfinder, `thorough` for the actual capture. */
  effort?: DetectEffort;
};

type Candidate = {
  quad: Quad;
  /** How much of the quad's rectangle the blob actually fills (0..1). */
  fill: number;
  /** Share of the image covered by the quad. */
  area: number;
  source: "mask" | "edges";
  /** The brightness the mask was built with, for mask candidates. */
  thr?: number;
};

/* ----------------------------------------------------------------- scoring */

function quadArea(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** How much two quads cover the same area (0..1). */
function quadIoU(a: Quad, b: Quad): number {
  // rasterise coarsely: exact polygon clipping is overkill for a sanity check
  const steps = 24;
  let both = 0;
  let either = 0;
  const inside = (q: Quad, x: number, y: number) => {
    let hit = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const p = q[i];
      const r = q[j];
      if (p.y > y !== r.y > y && x < ((r.x - p.x) * (y - p.y)) / (r.y - p.y) + p.x) hit = !hit;
    }
    return hit;
  };
  const minX = Math.min(...a.map((p) => p.x), ...b.map((p) => p.x));
  const maxX = Math.max(...a.map((p) => p.x), ...b.map((p) => p.x));
  const minY = Math.min(...a.map((p) => p.y), ...b.map((p) => p.y));
  const maxY = Math.max(...a.map((p) => p.y), ...b.map((p) => p.y));
  for (let iy = 0; iy < steps; iy++) {
    for (let ix = 0; ix < steps; ix++) {
      const x = minX + ((ix + 0.5) / steps) * (maxX - minX);
      const y = minY + ((iy + 0.5) / steps) * (maxY - minY);
      const inA = inside(a, x, y);
      const inB = inside(b, x, y);
      if (inA && inB) both++;
      if (inA || inB) either++;
    }
  }
  return either ? both / either : 0;
}

/** Scale a quad around its centroid. */
function scaleQuad(quad: Quad, factor: number): Quad {
  const cx = quad.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = quad.reduce((sum, p) => sum + p.y, 0) / 4;
  return quad.map((p) => ({
    x: cx + (p.x - cx) * factor,
    y: cy + (p.y - cy) * factor,
  })) as Quad;
}

/**
 * What the region inside the quad looks like compared to what is around it.
 *
 * Measured on a shrunken and an expanded copy of the quad, not on the edge
 * itself: a coarse candidate is often a few percent too large, and sampling
 * right at the border then compares desk with desk and rejects a perfectly
 * good page.
 */
function quadMetrics(
  quad: Quad,
  g: Float32Array,
  chroma: Float32Array,
  grad: Float32Array,
  w: number,
  h: number
): { inner: number; outer: number; innerChroma: number; outerChroma: number; edge: number } {
  const innerQuad = scaleQuad(quad, 0.82);
  const outerQuad = scaleQuad(quad, 1.14);
  const samples = 14;

  const lineMean = (q: Quad, buf: Float32Array) => {
    let sum = 0;
    let used = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      for (let k = 1; k < samples; k++) {
        const t = 0.12 + (0.76 * k) / (samples - 1);
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        sum += sampleBilinear(buf, w, h, x, y);
        used++;
      }
    }
    return used ? sum / used : 0;
  };

  // The coarse quad is usually a few pixels off the true edge (the mask is
  // dilated before hulling), so look for the gradient peak in a small band
  // instead of sampling exactly on the line.
  let edge = 0;
  let used = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    for (let k = 1; k < samples; k++) {
      const t = 0.1 + (0.8 * k) / (samples - 1);
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      let peak = 0;
      for (let o = -8; o <= 8; o++) {
        const x = px + nx * o;
        const y = py + ny * o;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const v = sampleBilinear(grad, w, h, x, y);
        if (v > peak) peak = v;
      }
      edge += peak;
      used++;
    }
  }

  return {
    inner: lineMean(innerQuad, g),
    outer: lineMean(outerQuad, g),
    innerChroma: lineMean(innerQuad, chroma),
    outerChroma: lineMean(outerQuad, chroma),
    edge: used ? edge / used : 0,
  };
}

type Metrics = ReturnType<typeof quadMetrics>;

/**
 * Combined "this is paper" evidence: the inside is brighter *or* noticeably
 * less colourful than the surroundings. Luma alone fails on a pale wooden desk,
 * which can match paper in brightness while being far warmer.
 */
function paperEvidence(m: Metrics): number {
  return m.inner - m.outer + 0.8 * (m.outerChroma - m.innerChroma);
}

/**
 * One number per candidate. Weighted for what actually goes wrong: a badly
 * filled rectangle (desk merged with paper) is worse than a slightly loose
 * one, and a quad with no paper evidence is not a sheet at all.
 */
function scoreCandidate(
  candidate: Candidate,
  g: Float32Array,
  chroma: Float32Array,
  grad: Float32Array,
  w: number,
  h: number
): number {
  const m = quadMetrics(candidate.quad, g, chroma, grad, w, h);
  if (candidate.fill < 0.6) return -1;

  // there must be real evidence that this is paper, unless the sheet fills the
  // frame so completely that there is nothing left to compare against
  const evidence = paperEvidence(m);
  if (evidence < 8 && candidate.area < 0.94) return -1;
  if (m.edge < 12 && candidate.area < 0.94) return -1;

  const contrast = clamp(evidence / 55, 0, 1);
  const sharpness = clamp(m.edge / 85, 0, 1);
  const fill = clamp((candidate.fill - 0.5) / 0.45, 0, 1);
  const area = clamp(candidate.area / 0.45, 0, 1);

  return 0.42 * fill + 0.3 * contrast + 0.2 * sharpness + 0.08 * area;
}

/* ------------------------------------------------------------- candidates */

/** Plausibility gate shared by every source. */
function plausible(quad: Quad, w: number, h: number): boolean {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const sides = [0, 1, 2, 3].map((i) => d(quad[i], quad[(i + 1) % 4]));
  const minSide = Math.min(...sides);
  const maxSide = Math.max(...sides);
  if (minSide < Math.min(w, h) * 0.14) return false;
  const aspect = maxSide / Math.max(1, minSide);
  if (aspect > 3.2 || aspect < 0.32) return false;
  const area = quadArea(quad) / (w * h);
  return area > 0.05 && area < 0.995;
}

/**
 * Bright, colour-neutral pixels = the sheet. One definition, used both to find
 * candidate blobs and to check a finished quad against the real paper.
 */
function paperMask(
  g: Float32Array,
  chroma: Float32Array,
  warmth: Float32Array,
  thr: number,
  out: Uint8Array
): Uint8Array {
  for (let i = 0; i < g.length; i++) {
    out[i] = g[i] > thr && chroma[i] < 62 && warmth[i] < 30 ? 1 : 0;
  }
  return out;
}

/** Connected bright, colour-neutral blobs → minimum-area rectangles. */
function maskCandidates(mask: Uint8Array, w: number, h: number, out: Candidate[], thr = 0): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const minArea = n * 0.04;

  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pts: number[] = [];
    while (stack.length) {
      const p = stack.pop()!;
      pts.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1;
        stack.push(p - 1);
      }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1;
        stack.push(p + 1);
      }
      if (y > 0 && mask[p - w] && !seen[p - w]) {
        seen[p - w] = 1;
        stack.push(p - w);
      }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) {
        seen[p + w] = 1;
        stack.push(p + w);
      }
    }
    if (pts.length < minArea) continue;

    const step = Math.max(1, Math.floor(pts.length / 5000));
    const cloud: Pt[] = [];
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      const x = p % w;
      cloud.push({ x, y: (p - x) / w });
    }
    const rect = minAreaRect(convexHull(cloud));
    if (!rect) continue;
    const rectArea = quadArea(rect as Quad);
    if (rectArea < 1) continue;
    const quad = orderQuad(rect);
    if (!plausible(quad, w, h)) continue;
    out.push({ quad, fill: pts.length / rectArea, area: quadArea(quad) / n, source: "mask", thr });
  }
}

/**
 * Fallback for sheets the colour mask cannot separate (white paper on a white
 * desk, a screen, paper under glass): start from a frame and let each side
 * slide onto the strongest bright-over-dark edge.
 */
/** Share of a quad's boundary that sits on a real gradient. */
function edgeCoverage(quad: Quad, grad: Float32Array, w: number, h: number): number {
  let strong = 0;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    for (let k = 1; k < 16; k++) {
      const t = k / 16;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (sampleBilinear(grad, w, h, x, y) > 14) strong++;
      total++;
    }
  }
  return total ? strong / total : 0;
}

function edgeCandidates(
  g: Float32Array,
  chroma: Float32Array,
  grad: Float32Array,
  w: number,
  h: number,
  out: Candidate[]
): void {
  // Several starting frames, because each side only searches locally: a seed
  // that already hugs the page finds the edge, one that is far away cannot.
  const seeds = [0.02, 0.1, 0.2, 0.3].map((inset) => fullFrameQuad(w, h, inset));
  let best: Quad | null = null;
  let bestScore = -Infinity;

  for (const seed of seeds) {
    let candidate = refineQuadByEdges(seed, g, grad, w, h, Math.min(w, h) * 0.3);
    candidate = refineQuadByEdges(candidate, g, grad, w, h, Math.min(w, h) * 0.06);
    if (!plausible(candidate, w, h)) continue;

    // A snap that barely moved is just "the whole photo", and a scene with no
    // page at all produces exactly that. Without these gates an empty desk
    // would be reported as a document.
    const moved =
      candidate.reduce((sum, p, i) => sum + Math.hypot(p.x - seed[i].x, p.y - seed[i].y), 0) / 4;
    if (moved < Math.min(w, h) * 0.015) continue;

    const m = quadMetrics(candidate, g, chroma, grad, w, h);
    if (m.edge < 16 || paperEvidence(m) < 8) continue;

    const area = quadArea(candidate) / (w * h);
    if (area < 0.15 || area > 0.98) continue;

    const coverage = edgeCoverage(candidate, grad, w, h);
    if (coverage < 0.45) continue;

    const score = paperEvidence(m) + m.edge + coverage * 40;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (!best) return;
  out.push({
    quad: best,
    fill: edgeCoverage(best, grad, w, h),
    area: quadArea(best) / (w * h),
    source: "edges",
  });
}

/* ------------------------------------------------------------------ entry */

/**
 * Find the sheet of paper and return its four corners.
 *
 * Three sources feed one ranked list of candidates:
 *   1. connected colour-neutral blobs at several thresholds (the reliable one),
 *   2. a lower threshold, which rescues shadowed paper,
 *   3. an edge snap from the frame, which rescues white-on-white scenes.
 * Every candidate is scored on fill, contrast (paper brighter than the desk),
 * edge sharpness and size; only the winner is then snapped precisely.
 */
/**
 * The single best sheet in a photo.
 *
 * Kept as its own name because almost every caller wants exactly one page; the
 * plural version exists for the book-open or two-receipts case, where splitting
 * is the difference between one scan and a wasted trip.
 */
export function detectPageQuad(img: ImageData, options: DetectOptions = {}): Quad | null {
  return detectPageQuads(img, options, 1)[0] ?? null;
}

function detectPageMain(img: ImageData, options: DetectOptions = {}): Quad | null {
  const thorough = (options.effort ?? "thorough") === "thorough";
  const planes = downscalePlanes(img, thorough ? 480 : 360);
  const { w, h } = planes;
  const n = w * h;
  const g = new Float32Array(n);
  const chroma = new Float32Array(n);
  const warmth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = planes.r[i];
    const gg = planes.g[i];
    const b = planes.b[i];
    g[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    chroma[i] = Math.max(r, gg, b) - Math.min(r, gg, b);
    warmth[i] = r - b;
  }

  // One field that behaves like "how much does this look like paper": bright
  // and colour-neutral scores high, a warm desk scores lower even when it is
  // just as bright. Used for edge polarity, where luma alone is blind.
  const paperness = new Float32Array(n);
  for (let i = 0; i < n; i++) paperness[i] = g[i] - 0.8 * chroma[i];

  const grad = colourGradient(planes);
  const base = otsu(g);
  // Otsu splits ink from paper, which is useless when the desk is as bright as
  // the paper. High percentiles isolate "the brightest surface" instead, so a
  // white sheet on a pale desk is still found.
  const raw = thorough
    ? [base * 0.9, base * 1.0, percentile(g, 0.8), percentile(g, 0.93)]
    : [base * 0.9, percentile(g, 0.8)];
  const thresholds: number[] = [];
  for (const t of raw) {
    const v = clamp(t, 95, 245);
    if (thresholds.every((existing) => Math.abs(existing - v) > 6)) thresholds.push(v);
  }

  const candidates: Candidate[] = [];
  const radius = Math.max(3, Math.round(Math.min(w, h) * 0.012));
  const seenKeys = new Set<string>();

  for (const t of thresholds) {
    const thr = Math.max(90, Math.min(235, t));
    const mask = paperMask(g, chroma, warmth, thr, new Uint8Array(n));
    const closed = morphClose(mask, w, h, radius);
    const found: Candidate[] = [];
    maskCandidates(closed, w, h, found, thr);
    if ((globalThis as { __dbgDetect?: boolean }).__dbgDetect) {
      let on = 0;
      for (let i = 0; i < n; i++) on += closed[i];
      console.log(" thr", thr.toFixed(0), "share", (on / n).toFixed(2), "cands", found.length,
        found.map((c) => {
          const mm = quadMetrics(c.quad, g, chroma, grad, w, h);
          return `fill=${c.fill.toFixed(2)} ev=${paperEvidence(mm).toFixed(0)} edge=${mm.edge.toFixed(0)} sc=${scoreCandidate(c, g, chroma, grad, w, h).toFixed(2)}`;
        }).join(" | "));
    }
    // the same sheet shows up at several thresholds: keep it once
    let added = 0;
    for (const c of found) {
      const key = c.quad.map((p) => `${Math.round(p.x / 10)},${Math.round(p.y / 10)}`).join("|");
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      candidates.push(c);
      added++;
    }
    // a confident hit at the first threshold makes the rest redundant
    if (added > 0 && scoreCandidate(found[0], g, chroma, grad, w, h) > 0.7) break;
  }

  // the frame snap is the rescue path for white-on-white, so it only runs when
  // the colour masks found nothing worth keeping
  if (!candidates.length && thorough) edgeCandidates(paperness, chroma, grad, w, h, candidates);
  if (!candidates.length) return null;

  let best: Candidate | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = scoreCandidate(c, g, chroma, grad, w, h);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best || bestScore <= 0) return null;

  // precise pass on the winner only: cheap, and keeps false positives out
  let refined = best.quad;
  const window = Math.max(6, Math.min(w, h) * 0.05);
  for (let pass = 0; pass < 3; pass++) {
    refined = refineQuadByEdges(refined, paperness, grad, w, h, window);
  }
  // the snap may move a corner a little, but never into nonsense
  if (!plausible(refined, w, h)) refined = best.quad;

  // Second opinion on the winner.
  //
  // Morphological closing glues the sheet to whatever lies against it — a pen,
  // a phone, a shadow — and the minimum-area rectangle then grows to swallow
  // that neighbour. The *unclosed* mask keeps them apart, so if one blob still
  // agrees with the winner, its rectangle is the honest one.
  if (best.thr) {
    const tight: Candidate[] = [];
    maskCandidates(paperMask(g, chroma, warmth, best.thr, new Uint8Array(n)), w, h, tight, best.thr);
    let pick: Candidate | null = null;
    let pickOverlap = 0;
    for (const c of tight) {
      const overlap = quadIoU(c.quad, refined);
      if (overlap < 0.55) continue;
      if (overlap > pickOverlap) {
        pick = c;
        pickOverlap = overlap;
      }
    }

    if (pick) {
      let tightQuad = pick.quad;
      for (let pass = 0; pass < 2; pass++) {
        tightQuad = refineQuadByEdges(tightQuad, paperness, grad, w, h, window);
      }
      const before = quadMetrics(refined, g, chroma, grad, w, h);
      const after = quadMetrics(tightQuad, g, chroma, grad, w, h);
      // Only when the sheet edge is actually visible. On a white-on-white or
      // shadowed scene the unclosed blob is a torn version of the page, and its
      // rectangle is worse than the one the full mask produced.
      if (plausible(tightQuad, w, h) && before.edge >= 95 && after.edge >= before.edge * 0.8) {
        refined = tightQuad;
      }
    }
  }

  // keep the paper edge out of the crop: a hair of white margin reads as
  // "scanned", a dark 1px rim reads as "photo"
  const fx = refined.reduce((sum, p) => sum + p.x, 0) / 4;
  const fy = refined.reduce((sum, p) => sum + p.y, 0) / 4;
  const shrink = 1 - 2.2 / Math.max(40, Math.min(w, h));
  const trimmed = refined.map((p) => ({
    x: fx + (p.x - fx) * shrink,
    y: fy + (p.y - fy) * shrink,
  })) as Quad;

  const inv = img.width / w;
  return orderQuad(trimmed.map((p) => ({ x: p.x * inv, y: p.y * inv })) as Quad);
}

/**
 * Up to `limit` sheets, best first.
 *
 * The second page is not a second-best guess: it has to be a *different*
 * rectangle (almost no overlap with the winner), it has to be plausible on its
 * own, and it has to score at least half as well. Two sheets side by side in a
 * photo are a real thing (an open book, two receipts); a corner of the same
 * sheet re-detected at another threshold is not.
 */
export function detectPageQuads(
  img: ImageData,
  options: DetectOptions = {},
  limit = 2
): Quad[] {
  const first = detectPageMain(img, options);
  if (!first || limit < 2) return first ? [first] : [];

  // Paint the found sheet out and look again: whatever is left is a separate
  // object, which is much more honest than ranking blobs of one page. The copy
  // is small on purpose — a full-resolution duplicate of a 12MP photo is 40 MB
  // of memory for a search that runs at 480px anyway.
  const small = downscaleRgba(img, 900);
  const k = small.width / img.width;
  blankOutside(small, rescaleQuad(first, k));
  const found = detectPageMain(small, options);
  if (!found) return [first];
  const second = rescaleQuad(found, 1 / k);
  if (quadIoU(first, second) > 0.12) return [first];
  if (!plausibleQuad(first, second)) return [first];
  return [first, second];
}

/** Map a quad between two resolutions. */
function rescaleQuad(quad: Quad, k: number): Quad {
  return quad.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad;
}

/** Box-downscale RGBA. Only used to search the second sheet. */
function downscaleRgba(img: ImageData, maxSide: number): ImageData {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  if (w === img.width && h === img.height) return new ImageData(new Uint8ClampedArray(img.data), w, h);
  const out = new ImageData(w, h);
  const dx = img.width / w;
  const dy = img.height / h;
  const src = img.data;
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * dy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * dy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * dx);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * dx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * img.width;
        for (let xx = x0; xx < x1; xx++) {
          const i = (row + xx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      dst[o] = r / n;
      dst[o + 1] = g / n;
      dst[o + 2] = b / n;
      dst[o + 3] = 255;
    }
  }
  return out;
}

/** The first sheet's corners, mapped back — the mask is the same size. */
function blankOutside(img: ImageData, quad: Quad): void {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(img.width, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(img.height, Math.ceil(Math.max(...ys)));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!insideQuad({ x, y }, quad)) continue;
      const i = (y * img.width + x) * 4;
      // desk-coloured, so the paper mask cannot see it as a sheet
      img.data[i] = 90;
      img.data[i + 1] = 88;
      img.data[i + 2] = 84;
    }
  }
}

function insideQuad(p: { x: number; y: number }, quad: Quad): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = quad[i];
    const b = quad[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Both rectangles have to be sheet-shaped, not a sliver or a triangle. */
function plausibleQuad(a: Quad, b: Quad): boolean {
  const area = (q: Quad) => quadArea(q);
  const sa = area(a);
  const sb = area(b);
  if (sb < sa * 0.18 || sb > sa * 1.35) return false;
  const sides = (q: Quad) =>
    q.map((p, i) => Math.hypot(q[(i + 1) % 4].x - p.x, q[(i + 1) % 4].y - p.y));
  const s = sides(b);
  const longest = Math.max(...s);
  const shortest = Math.min(...s);
  return shortest > longest * 0.25;
}



type Planes = { r: Float32Array; g: Float32Array; b: Float32Array; w: number; h: number };

/** Downscale the three colour planes; detection needs more than luma. */
function downscalePlanes(img: ImageData, maxSide: number): Planes {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  const sx = img.width / w;
  const sy = img.height / h;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const base = yy * img.width;
        for (let xx = x0; xx < x1; xx++) {
          const i = (base + xx) * 4;
          ar += d[i];
          ag += d[i + 1];
          ab += d[i + 2];
          n++;
        }
      }
      const i = y * w + x;
      r[i] = ar / n;
      g[i] = ag / n;
      b[i] = ab / n;
    }
  }
  return { r, g, b, w, h };
}

/**
 * Edge strength across all three channels. Paper on a pale wooden desk can have
 * the same brightness as the desk and still be an obvious edge in colour, which
 * a luma-only Sobel misses completely.
 */
function colourGradient(p: Planes): Float32Array {
  const { r, g, b, w, h } = p;
  const out = new Float32Array(w * h);
  const sobel = (buf: Float32Array, x: number, y: number) => {
    const i = y * w + x;
    const tl = buf[i - w - 1];
    const tc = buf[i - w];
    const tr = buf[i - w + 1];
    const ml = buf[i - 1];
    const mr = buf[i + 1];
    const bl = buf[i + w - 1];
    const bc = buf[i + w];
    const br = buf[i + w + 1];
    const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
    const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
    return Math.hypot(gx, gy) / 4;
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = Math.max(sobel(r, x, y), sobel(g, x, y), sobel(b, x, y));
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

/**
 * Pull the quad inwards by `ratio` of its own size.
 *
 * Detection and hand-placed corners both tend to sit a pixel or two outside the
 * paper, which shows up as a dark desk edge along the finished page. A small
 * inset costs a sliver of margin and removes the whole artefact.
 */
export function insetQuad(quad: Quad, ratio = 0.006): Quad {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const side = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
  const height = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
  // inset by the smaller dimension, so a sliver along the long edge stays slim
  const px = Math.max(1, Math.min(side, height) * ratio);
  const scale = Math.max(0, 1 - (px * 2) / Math.max(1, Math.min(side, height)));
  return quad.map((p) => ({ x: cx + (p.x - cx) * scale, y: cy + (p.y - cy) * scale })) as Quad;
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

/**
 * The settings the Optimize switch uses, in one place.
 *
 * Optimize is offered as a single switch, but the numbers behind it have to agree
 * in three code paths (preview, export, README pictures) — and a preview that is
 * tuned differently from the export is a scan that changes when you save it.
 */
export const OPTIMIZE = { mode: "bw", brightness: 0, contrast: 0, strength: 58 } as const;

export type EnhanceOpts = {
  mode: Mode;
  brightness: number; // -50..50
  contrast: number; // -50..50
  /** 0..100, only for bw: how aggressive the adaptive threshold is */
  strength?: number;
  /** Unsharp amount applied before the ink mapping, 0 = off. */
  sharpen?: number;
  /** The neighbourhood the paper and ink values come from (px, 0 = derive). */
  window?: number;
};

/* Everything below runs at the caller's resolution — up to 3000px on the long
 * side for an export. The rules that make it fast:
 *
 *  1. statistics come from a small copy, never from the full image;
 *  2. every spatially varying map (light, threshold) is sampled through a
 *     precomputed row sampler, so a pixel costs a few array reads instead of a
 *     bilinear interpolation with four clamps;
 *  3. tone mapping is a 256-entry lookup table, so per pixel it is one multiply
 *     and one table read;
 *  4. buffers are bytes, reused, and written once.
 */

/** Luma in a byte plane: half the memory of Float32 and enough for 8-bit out. */
function lumaBytes(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  into?: Uint8Array
): Uint8Array {
  const out = into ?? new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
  }
  return out;
}

/** Area-average downsample of a byte plane. */
function shrink(src: Uint8Array | Float32Array, w: number, h: number, maxSide: number) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const mw = Math.max(8, Math.round(w * s));
  const mh = Math.max(8, Math.round(h * s));
  if (mw === w && mh === h) return { map: Float32Array.from(src), w: mw, h: mh };
  const out = new Float32Array(mw * mh);
  const sx = w / mw;
  const sy = h / mh;
  for (let y = 0; y < mh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(h, Math.floor((y + 1) * sy)));
    for (let x = 0; x < mw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(w, Math.floor((x + 1) * sx)));
      let acc = 0;
      for (let yy = y0; yy < y1; yy++) {
        const base = yy * w;
        for (let xx = x0; xx < x1; xx++) acc += src[base + xx];
      }
      out[y * mw + x] = acc / ((y1 - y0) * (x1 - x0));
    }
  }
  return { map: out, w: mw, h: mh };
}

/** Separable box blur on a small float map. */
function blur(src: Float32Array | Uint8Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      acc += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm;
      acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

/**
 * Bilinear upsampler from a small map to full resolution. The horizontal weights
 * are computed once; reading a row is then a handful of array lookups per pixel.
 */
function rowSampler(map: Float32Array, mw: number, mh: number, w: number, h: number) {
  const x0 = new Int32Array(w);
  const x1 = new Int32Array(w);
  const tx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = clamp(((x + 0.5) * mw) / w - 0.5, 0, mw - 1);
    const i0 = Math.floor(fx);
    x0[x] = i0;
    x1[x] = Math.min(mw - 1, i0 + 1);
    tx[x] = fx - i0;
  }
  return (y: number, out: Float32Array) => {
    const fy = clamp(((y + 0.5) * mh) / h - 0.5, 0, mh - 1);
    const r0 = Math.floor(fy);
    const r1 = Math.min(mh - 1, r0 + 1);
    const ty = fy - r0;
    const a = r0 * mw;
    const b = r1 * mw;
    for (let x = 0; x < w; x++) {
      const i0 = x0[x];
      const i1 = x1[x];
      const t = tx[x];
      const av = map[a + i0] + (map[a + i1] - map[a + i0]) * t;
      const bv = map[b + i0] + (map[b + i1] - map[b + i0]) * t;
      out[x] = av + (bv - av) * ty;
    }
  };
}


/**
 * Local minimum and maximum, separable: rows first, then columns.
 *
 * Knowing the darkest and the brightest value of a neighbourhood is what lets a
 * pixel be described as "this far between paper and ink" instead of "darker than
 * a number" — and that is what keeps a thin stroke thin (see `enhance`).
 */

function histOf(plane: Uint8Array | Float32Array, length = plane.length): Uint32Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < length; i++) hist[clamp(Math.round(plane[i]), 0, 255)]++;
  return hist;
}

function percentileOf(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/**
 * Lighting map: the page as the camera lit it, heavily blurred.
 *
 * Dividing it out is what turns "a photo of paper with a shadow" into "paper".
 * The target is the 75th percentile of the lighting map, so a normally lit page
 * keeps its white and a dim one is lifted to it.
 */
function lighting(gray: Uint8Array, w: number, h: number) {
  const small = shrink(gray, w, h, 320);
  const light = blur(small.map, small.w, small.h, Math.max(4, Math.round(Math.max(small.w, small.h) / 12)));
  const hist = histOf(light);
  const target = Math.max(96, percentileOf(hist, light.length, 0.75));
  return { light, lw: small.w, lh: small.h, target };
}

/**
 * Unsharp mask on a byte plane, separable, rolling rows.
 *
 * Text is high-frequency; the sharpen has to happen *before* the threshold so
 * glyph edges reach it crisp, which is what makes small print readable instead
 * of grey mush.
 */
function sharpen(plane: Uint8Array, w: number, h: number, amount: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const rowBlur = (y: number, into: Int16Array) => {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = plane[row + (x > 0 ? x - 1 : x)];
      const c = plane[row + x];
      const r = plane[row + (x < w - 1 ? x + 1 : x)];
      into[x] = (l + 2 * c + r) >> 2;
    }
  };
  const prev = new Int16Array(w);
  const curr = new Int16Array(w);
  const next = new Int16Array(w);
  rowBlur(0, curr);
  rowBlur(h > 1 ? 1 : 0, next);
  for (let y = 0; y < h; y++) {
    if (y > 0) {
      prev.set(curr);
      curr.set(next);
      rowBlur(Math.min(h - 1, y + 1), next);
    }
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = plane[row + x];
      const b = (prev[x] + 2 * curr[x] + next[x]) >> 2;
      const sharp = v + ((v - b) * amount) | 0;
      out[row + x] = sharp < 0 ? 0 : sharp > 255 ? 255 : sharp;
    }
  }
  return out;
}

/**
 * How bright this part of the *paper* is, all over the page.
 *
 * Not a plain blur: a blur is pulled down by the ink it covers, and where the
 * ink is a glyph the local paper value dips in the middle of the stroke — which
 * makes letters hollow, dark at the edges and pale in the middle. Ink only ever
 * makes a pixel darker than its paper, so the honest estimate is a maximum: the
 * brightest pixel in a neighbourhood is paper.
 *
 * Computed as a max over small blocks (a hundredth of the work of a full
 * morphological pass), smoothed on the small map, and upsampled through the same
 * row sampler the lighting map uses. The blocks are a few pixels wide, so a
 * stroke one or two pixels thick cannot fill one — which is what keeps the
 * estimate on the paper even inside dense text.
 */
function paperEstimate(src: Uint8Array, w: number, h: number): Float32Array {
  const step = Math.max(2, Math.round(Math.max(w, h) / 220));
  const mw = Math.max(1, Math.ceil(w / step));
  const mh = Math.max(1, Math.ceil(h / step));
  const pooled = new Float32Array(mw * mh);
  for (let my = 0; my < mh; my++) {
    const y0 = my * step;
    const y1 = Math.min(h, y0 + step);
    for (let mx = 0; mx < mw; mx++) {
      const x0 = mx * step;
      const x1 = Math.min(w, x0 + step);
      let best = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          const v = src[row + x];
          if (v > best) best = v;
        }
      }
      pooled[my * mw + mx] = best;
    }
  }
  // a max filter leaves block edges behind; two small blurs turn it into a map of
  // the light on the page, which is what it is meant to be
  const smooth = blur(blur(pooled, mw, mh, 1), mw, mh, 1);
  const sample = rowSampler(smooth, mw, mh, w, h);
  const out = new Float32Array(w * h);
  const row = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    sample(y, row);
    out.set(row, y * w);
  }
  return out;
}

/**
 * Turn a warped photo into a page.
 *
 * `bw` is the Optimize button: flatten the light, stretch the tones, sharpen,
 * then threshold with soft coverage so glyph edges stay smooth. `gray` and
 * `color` keep the same lighting and tone work and skip the threshold.
 */
export function enhance(src: ImageData, opts: EnhanceOpts): ImageData {
  const { width: w, height: h } = src;
  const out = new ImageData(w, h);
  const o = out.data;
  const n = w * h;
  const gray = lumaBytes(src.data, w, h);
  const { light, lw, lh, target } = lighting(gray, w, h);
  const lightRow = rowSampler(light, lw, lh, w, h);
  const brightness = clamp(opts.brightness ?? 0, -50, 50) / 100;
  const contrast = clamp(opts.contrast ?? 0, -50, 50) / 100;

  /* Tone curve: levels from the *lit* page itself, then contrast and
   * brightness, baked into a table. One multiply and one lookup per pixel
   * afterwards.
   *
   * The histogram is taken from the lit image, not from the lighting map: the
   * map is a smooth blur of the page and has almost no range, so stretching to
   * its 2–98% band turned a five-level shadow into a black smudge. Sampling
   * every few pixels keeps this pass cheap. */
  const gainOf = (bg: number) => (bg < 12 ? 1 : clamp(target / bg, 0.55, 2.6));
  const gainRow = new Float32Array(w);
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(n / 40000)));
  const hist = new Uint32Array(256);
  let samples = 0;
  for (let y = 0; y < h; y += sampleStep) {
    lightRow(y, gainRow);
    const row = y * w;
    for (let x = 0; x < w; x += sampleStep) {
      const v = gray[row + x] * gainOf(gainRow[x]);
      hist[v > 255 ? 255 : v < 0 ? 0 : v | 0]++;
      samples++;
    }
  }
  let lo = percentileOf(hist, samples, 0.02);
  let hi = percentileOf(hist, samples, 0.985);
  // a flatter page than this needs no level stretch at all
  if (hi - lo < 24) {
    lo = 0;
    hi = 255;
  }
  const span = Math.max(1, hi - lo);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let t = clamp((v - lo) / span, 0, 1);
    if (contrast !== 0) {
      // gentle S-curve rather than a hard clip
      const s = t * t * (3 - 2 * t);
      t = clamp(t + (s - t) * contrast * 1.2 + (t - 0.5) * contrast * 0.6, 0, 1);
    }
    const x = clamp(t + brightness * 0.5, 0, 1);
    lut[v] = Math.round(x * 255);
  }

  /* Normalise + tone in one pass. */
  const norm = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    lightRow(y, gainRow);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const g = gainOf(gainRow[x]);
      let v = gray[row + x] * g + 0.5;
      norm[row + x] = lut[v > 255 ? 255 : v < 0 ? 0 : v | 0];
    }
  }

  if (opts.mode !== "bw") {
    const sharp = sharpen(norm, w, h, 0.61);
    if (opts.mode === "gray") {
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const v = sharp[i];
        o[p] = v;
        o[p + 1] = v;
        o[p + 2] = v;
        o[p + 3] = 255;
      }
      return out;
    }
    // colour: lift every channel by the light gain, then keep a little saturation
    for (let y = 0; y < h; y++) {
      lightRow(y, gainRow);
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const p = i * 4;
        const g = gainOf(gainRow[x]);
        const delta = sharp[i] - clamp(Math.round(gray[i] * g), 0, 255);
        let r = clamp(src.data[p] * g + delta, 0, 255);
        let gg = clamp(src.data[p + 1] * g + delta, 0, 255);
        let b = clamp(src.data[p + 2] * g + delta, 0, 255);
        const luma = 0.299 * r + 0.587 * gg + 0.114 * b;
        r = clamp(luma + (r - luma) * 1.06, 0, 255);
        gg = clamp(luma + (gg - luma) * 1.06, 0, 255);
        b = clamp(luma + (b - luma) * 1.06, 0, 255);
        o[p] = r;
        o[p + 1] = gg;
        o[p + 2] = b;
        o[p + 3] = 255;
      }
    }
    return out;
  }

  /* Optimize: describe every pixel as "how far between paper and ink", then
   * clean the specks and write black on white.
   *
   * This used to be a Sauvola-style threshold: compare the pixel with a local
   * mean and decide black/white, with a soft ramp to keep edges smooth. It read
   * as a photocopier from 1995 — anything noticeably darker than its
   * surroundings became *solid* black, so thin strokes grew and neighbouring
   * letters merged (a "rn" turning into an "m" is what makes a scan unreadable
   * for both eyes and OCR).
   *
   * What a scanner actually does is simpler and better: find the paper and the
   * ink *of this neighbourhood* (the local max and min) and map the pixel in
   * between. A stroke centre lands at 100% ink, its antialiased edge at 50%,
   * paper at 0% — so a hairline stays a hairline, and text keeps the weight it
   * had on the sheet. Flat areas (contrast below a floor) are paper by
   * definition, which is also what removes a shadow without turning it grey.
   */
  /* Sharpen *before* the ink mapping, not after.
   *
   * A 200 DPI photo of a sheet drawn at 0.7× has hairlines about one pixel wide;
   * the warp's bilinear pass and the blur below both soften those to a grey
   * smudge, and the local paper/ink comparison then has almost nothing to work
   * with — the stroke keeps whatever grey it had, the neighbouring rule breaks up
   * into dashes, and small type reads "ragged" even though every step did what it
   * promised. An unsharp pass puts the edge back where it was on the paper, and
   * the mapping only has to decide black-or-white for a clean edge. */
  /* ---------------------------------------------------------------- mapping
   *
   * Describe every pixel by *how much ink* it carries, against the paper around
   * it, and write that as black on white.
   *
   * What is here now replaces an ink/paper-per-window mapping (local min and max
   * from a blurred copy). That approach reads well in a paragraph and fails on a
   * page: the window's max is a paper value where the window is empty and a grey
   * value where a rule happens to fill it, so the same stroke came out solid
   * black in one place and pale grey three lines further down, thin table rules
   * dissolved into dashes, and a light grey table band was alternately "paper"
   * and "ink" depending on what else the window happened to contain.
   *
   * The paper, though, does not vary per 20 pixels — it varies slowly, with the
   * lamp. So the paper is estimated once, from a wide blur (the same map the
   * lighting pass uses, at full resolution), and the ink level is one number for
   * the page: the 1st percentile of the normalised image. A stroke's coverage is
   * then (paper - pixel) / (paper - ink), which is what "how black is this
   * stroke" actually means, and it is the same scale everywhere on the page.
   *
   * Two consequences worth stating:
   *
   *  - thin strokes survive. A one-pixel rule is thin, not faint: with the grey
   *    itself deciding instead of a local max, it lands at that same coverage
   *    everywhere along its length instead of breaking into dashes.
   *  - the ramp is soft, so the glyph edges stay antialiased and text keeps the
   *    weight it had on paper rather than being thickened by a hard threshold.
   */
  const sharpened = sharpen(norm, w, h, opts.sharpen ?? 0.55);
  const paper = paperEstimate(sharpened, w, h);
  // one ink level for the page: the darkest 1% of the normalised image, which is
  // the printed ink and not the noise around it
  const normHist = histOf(sharpened);
  const inkLevel = Math.min(200, percentileOf(normHist, n, 0.01));
  const strength = clamp(opts.strength ?? 55, 0, 100) / 100;
  // Where in the paper→ink range the ink starts, and where it is fully black.
  // The ramp between them is deliberately wide: it is the antialiased rim of a
  // glyph, and a scan of printed text has one. A narrow ramp looks "crisp" in a
  // thumbnail and stamps the letters flat, which is what merged an "rn" into an
  // "m" back when this was a hard threshold.
  const knee = 0.34 - strength * 0.16;
  const top = 0.92;
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const paperHere = paper[i];
    const span = paperHere - inkLevel;
    if (span < 24 || paperHere < 32) {
      // a window with almost no range between paper and ink holds no text
      ink[i] = 0;
      continue;
    }
    // 0 at the paper's own value, 1 at the page's ink
    const v = (paperHere - sharpened[i]) / span;
    if (v <= knee) {
      ink[i] = 0;
      continue;
    }
    const cover = v >= top ? 1 : (v - knee) / (top - knee);
    // Below a hair of coverage this is grain on the paper, not a glyph edge:
    // printing a 5% speck is what makes a clean page look dusty.
    ink[i] = (cover < 0.06 ? 0 : cover) * 255;
  }

  /* Despeckle and expand to RGBA in one pass: a lone dark pixel is grain, never
     a glyph, so it must not survive as a black dot on white paper.
   *
   * Two rules, because the old single one ate hairlines:
   *
   *  - a pixel alone in its *eight*-neighbourhood is grain — remove it. Four
   *    neighbours are not enough to tell: a diagonal stroke, or a table rule that
   *    runs at an angle after the warp, has no orthogonal partner either.
   *  - but only if it is a *weak* speck. A paper hair or a JPEG artefact lands
   *    somewhere in the ramp; the one-pixel-wide rule of a table is fully black
   *    in the ink map, and deleting its isolated pixels is exactly what turned a
   *    rule into a dashed line. */
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? row - w : row;
    const down = y < h - 1 ? row + w : row;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let cover = ink[i];
      if (cover > 90) {
        const left = x > 0 ? i - 1 : i;
        const right = x < w - 1 ? i + 1 : i;
        let neighbours = 0;
        if (ink[left] > 90) neighbours++;
        if (ink[right] > 90) neighbours++;
        if (ink[up + x] > 90) neighbours++;
        if (ink[down + x] > 90) neighbours++;
        if (ink[up + left] > 90) neighbours++;
        if (ink[up + right] > 90) neighbours++;
        if (ink[down + left] > 90) neighbours++;
        if (ink[down + right] > 90) neighbours++;
        // a lone mid-grey pixel is grain. A *black* one is a dot in the print, and
        // a stroke that came out one pixel wide has neighbours anyway.
        if (neighbours === 0 && cover < 150) cover = 0;
        else if (neighbours === 1 && cover < 110) cover = 0;
      }
      const v = 255 - cover;
      const p = i * 4;
      o[p] = v;
      o[p + 1] = v;
      o[p + 2] = v;
      o[p + 3] = 255;
    }
  }
  return out;
}
