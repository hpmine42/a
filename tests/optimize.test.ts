import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { detectPageQuad, enhance, insetQuad, OPTIMIZE, outputSize, warp } from "../src/lib/cv";

/**
 * What Optimize has to do to a page of text.
 *
 * This is the part users judge the whole scanner by, and it is the part that is
 * easy to get subtly wrong: an ink mapping can look fine in a thumbnail and still
 * eat hairlines, hollow out letters or leave a grey wash behind. So it is measured
 * here on a synthesised page with known geometry — strokes of a known thickness,
 * a known step in brightness, a grey band.
 */

type Page = { img: ImageData; strokeWidth: number; rows: number[]; bands: [number, number][] };

const PAPER = 236;

/**
 * A page: a lamp gradient across it, a grey band (like a table header), and lines
 * of "text" as horizontal strokes of `strokeWidth` pixels.
 */
function page(
  w = 400,
  h = 560,
  opts: { strokeWidth?: number; lines?: number; band?: boolean } = {}
): Page {
  const strokeWidth = opts.strokeWidth ?? 2;
  const lines = opts.lines ?? 14;
  const img = new ImageData(w, h);
  const rows: number[] = [];
  for (let i = 0; i < lines; i++) rows.push(40 + Math.round((i * (h - 80)) / lines));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // the lamp: brighter at the top left, 18% darker at the bottom right
      const light = 1.02 - 0.36 * (x / w) - 0.12 * (y / h);
      let v = PAPER * light;
      for (const row of rows) {
        if (x <= 22 || x >= w - 22) continue;
        // a soft edge on both sides of the stroke, like rendered type: without it
        // the page is a synthetic 1-bit pattern and any threshold looks perfect
        const up = row - y; // >0: this pixel is above the stroke
        const down = y - (row + strokeWidth - 1);
        const off = up > 0 ? up : down > 0 ? down : 0;
        const cover = off === 0 ? 1 : off === 1 ? 0.45 : off === 2 ? 0.12 : 0;
        if (cover > 0) v = v * (1 - cover) + 34 * light * cover;
      }
      if (opts.band && y > 240 && y < 300) v *= 0.93;
      const p = (y * w + x) * 4;
      img.data[p] = v;
      img.data[p + 1] = v;
      img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  return { img, strokeWidth, rows, bands: opts.band ? [[240, 300]] : [] };
}

const lumaAt = (img: ImageData, x: number, y: number) => img.data[(y * img.width + x) * 4];

/** How many of the page's ink pixels are mid-grey (the antialiased rim). */
function midToneShare(img: ImageData): number {
  let mid = 0;
  let inked = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i];
    if (v < 215) inked++;
    if (v > 40 && v < 225) mid++;
  }
  return inked ? mid / inked : 0;
}

describe("Optimize", () => {
  it("prints black ink on white paper, not grey on grey", () => {
    const { img } = page();
    const out = enhance(img, OPTIMIZE);
    let dark = 0;
    let sum = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i] < 80) dark++;
      sum += out.data[i];
    }
    expect(dark).toBeGreaterThan(0);
    // the paper is paper: the page averages near-white
    expect(sum / (out.width * out.height)).toBeGreaterThan(232);
    // and the ink is ink (sampled in the core of the first stroke, not on its rim)
    expect(lumaAt(out, 200, out && 40)).toBeLessThan(90);
  });

  it("keeps a one-pixel rule a rule, instead of breaking it into dashes", () => {
    // the bug behind "the resolution is bad": the old despeckle deleted any dark
    // pixel with no orthogonal neighbour, and a hairline *is* one pixel wide
    const { img, rows } = page(400, 300, { strokeWidth: 1, lines: 4 });
    const out = enhance(img, OPTIMIZE);
    for (const row of rows) {
      const y = row;
      let dark = 0;
      let total = 0;
      for (let x = 40; x < out.width - 40; x++) {
        let best = 255;
        for (let dy = -1; dy <= 1; dy++) best = Math.min(best, lumaAt(out, x, y + dy));
        if (best < 110) dark++;
        total++;
      }
      // the stroke survives along its whole length: no dashes, no gaps
      expect(dark / total).toBeGreaterThan(0.9);
    }
  });

  it("keeps the same stroke equally dark across a lamp gradient", () => {
    // paper and ink are compared *locally*, against the paper of this part of the
    // page: a stroke at the dim edge must not be paler than the same stroke at the
    // bright edge, which is what made text look unevenly printed
    const { img, rows } = page(600, 400, { strokeWidth: 2, lines: 3 });
    const out = enhance(img, OPTIMIZE);
    const sample = (x: number) => {
      let sum = 0;
      let n = 0;
      for (const row of rows) {
        for (let dy = 0; dy < 2; dy++) {
          sum += lumaAt(out, x, row + dy);
          n++;
        }
      }
      return sum / n;
    };
    const left = sample(80);
    const right = sample(520);
    expect(Math.abs(left - right)).toBeLessThan(30);
  });

  it("leaves a light grey band alone instead of turning it into a texture", () => {
    const { img } = page(400, 560, { strokeWidth: 2, lines: 14, band: true });
    const out = enhance(img, OPTIMIZE);
    // inside the band, away from any stroke, the page is still paper
    let dark = 0;
    let n = 0;
    for (let y = 250; y < 290; y++) {
      for (let x = 60; x < out.width - 60; x++) {
        let nearStroke = false;
        for (let dy = -4; dy <= 4; dy++) {
          const py = y + dy;
          if (py < 0 || py >= out.height) continue;
          if (lumaAt(img, x, py) < 120) nearStroke = true;
        }
        if (nearStroke) continue;
        if (lumaAt(out, x, y) < 200) dark++;
        n++;
      }
    }
    expect(n).toBeGreaterThan(1000);
    expect(dark / n).toBeLessThan(0.02);
  });

  it("keeps the antialiased rim of every glyph", () => {
    // A hard threshold stamps letters flat, which is what merged an "rn" into an
    // "m". A scan of printed text always has a band of mid-grey along the edges.
    const { img } = page();
    const out = enhance(img, OPTIMIZE);
    expect(midToneShare(out)).toBeGreaterThan(0.15);
  });

  it("does not grow the ink: a two-pixel stroke stays two pixels", () => {
    const { img, rows } = page(400, 300, { strokeWidth: 2, lines: 4 });
    const out = enhance(img, OPTIMIZE);
    for (const row of rows) {
      let thick = 0;
      for (let y = row - 2; y <= row + 4; y++) if (lumaAt(out, 200, y) < 128) thick++;
      expect(thick).toBeLessThanOrEqual(3);
      expect(thick).toBeGreaterThanOrEqual(2);
    }
  });

  it("is cheap enough for a preview on a phone", () => {
    const { img } = page(900, 1300);
    const t0 = performance.now();
    enhance(img, OPTIMIZE);
    const ms = performance.now() - t0;
    // an A4 page at 1500px on the long side used to cost several seconds on a
    // phone; the local max/min window per pixel was most of it
    expect(ms).toBeLessThan(1200);
  });
});

/**
 * The same question on a *real* photo: the demo the app ships.
 *
 * The synthetic page above is precise about geometry; this one is about the mess
 * a camera produces — JPEG ringing, a lamp gradient, antialiased rules — which is
 * where the mapping actually failed before:
 *
 *  - table rules came out as dashed lines (some of them only a third of their
 *    length was dark), because a one-pixel stroke blurred into a grey smudge has
 *    no local contrast left for a min/max window to find;
 *  - and rows of small type were smeared into full-width dark bars.
 *
 * Both are visible in one measurement: how many rows across the table are mostly
 * dark, and how continuous each of those rows is.
 */
describe("Optimize on a photographed page", () => {
  const sample = () => {
    const raw = jpeg.decode(readFileSync(resolve(process.cwd(), "public/samples/letter.jpg")), {
      useTArray: true,
    });
    const photo = new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height);
    const quad = detectPageQuad(photo);
    expect(quad).not.toBeNull();
    const size = outputSize(insetQuad(quad!, 0.008), 1200);
    return enhance(warp(photo, insetQuad(quad!, 0.008), size.w, size.h), OPTIMIZE);
  };

  it("keeps every table rule continuous from one end to the other", () => {
    const out = sample();
    const W = out.width;
    const H = out.height;
    const dark = (x: number, y: number) => out.data[(y * W + x) * 4] < 128;
    const x0 = Math.round(W * 0.06);
    const x1 = Math.round(W * 0.94);

    const rules: number[] = [];
    for (let y = Math.round(H * 0.28); y < Math.round(H * 0.45); y++) {
      let n = 0;
      for (let x = x0; x < x1; x++) if (dark(x, y)) n++;
      if (n / (x1 - x0) > 0.5) rules.push(y);
    }

    // the table has its header band and four rules; a page that produced dozens
    // of "rules" was smearing rows of type into bars
    expect(rules.length).toBeGreaterThan(2);
    expect(rules.length).toBeLessThan(12);

    for (const y of rules) {
      let run = 0;
      let best = 0;
      for (let x = x0; x < x1; x++) {
        let hit = false;
        for (let dy = -2; dy <= 2; dy++) if (dark(x, y + dy)) hit = true;
        run = hit ? run + 1 : 0;
        if (run > best) best = run;
      }
      // within a couple of pixels everywhere along the rule: dashes fail here
      expect(best / (x1 - x0)).toBeGreaterThan(0.85);
    }
  });
});
