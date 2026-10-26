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

/** Connected bright, colour-neutral blobs → minimum-area rectangles. */
function maskCandidates(mask: Uint8Array, w: number, h: number, out: Candidate[]): void {
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
    out.push({ quad, fill: pts.length / rectArea, area: quadArea(quad) / n, source: "mask" });
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
export function detectPageQuad(img: ImageData, options: DetectOptions = {}): Quad | null {
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
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      mask[i] = g[i] > thr && chroma[i] < 62 && warmth[i] < 30 ? 1 : 0;
    }
    const closed = morphClose(mask, w, h, radius);
    const found: Candidate[] = [];
    maskCandidates(closed, w, h, found);
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
    const ink = new Uint8Array(w * h);

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
        ink[y * w + x] = gray[y * w + x] < t ? 1 : 0;
      }
    }

    // Despeckle: paper grain and JPEG noise produce isolated dark pixels that
    // read as dirt once the page is pure black and white. Drop a pixel only if
    // it stands alone — real glyph strokes always have neighbours.
    const clean = new Uint8Array(ink);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!ink[i]) continue;
        const n = ink[i - 1] + ink[i + 1] + ink[i - w] + ink[i + w] +
          ink[i - w - 1] + ink[i - w + 1] + ink[i + w - 1] + ink[i + w + 1];
        if (n <= 1) clean[i] = 0;
      }
    }

    // Rescale so the result keeps a little anti-aliasing: at 1:1 the ink is
    // black, but the page is exported at a higher resolution than we screen it.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const isInk = clean[i] === 1;
        let val = isInk ? 0 : 255;
        if (!isInk) {
          // faint neighbours of ink become off-white, which keeps small text
          // readable when the PDF is scaled up
          const around =
            (x > 0 && clean[i - 1]) ||
            (x < w - 1 && clean[i + 1]) ||
            (y > 0 && clean[i - w]) ||
            (y < h - 1 && clean[i + w]);
          if (around) val = 236;
        }
        const idx = i * 4;
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
