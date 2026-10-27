/**
 * Rebuild the before/after pictures in the README from the real pipeline.
 *
 * Two things made the old pair useless as evidence:
 *
 *  - the sample photo was 1200px wide, which put the page at 597px. Body text
 *    was six pixels tall there, so *every* Optimize pass looks ragged, and the
 *    "after" was effectively a 2× blow-up of a 1-bit bitmap. The photo is now
 *    rendered at 2400×1800 by `scripts/make-sample.ts`, at 200 DPI on the sheet.
 *  - the page was rendered at 1500px on the long side and then shrunk into a
 *    README column, which throws away exactly the detail the picture is meant to
 *    prove. The page is written at its own resolution now (up to 2200px, the
 *    size the app renders for export), and the README displays it *large*.
 *
 * The pipeline is the app's own: same detection, same inset, same strength, same
 * order. If Optimize ever gets worse, these pictures get worse with it — that is
 * the point of generating them instead of keeping a flattering one.
 *
 *   npm run docs:images
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { detectPageQuad, enhance, insetQuad, OPTIMIZE, outputSize, warp } from "../src/lib/cv";
import { EDGE_INSET } from "../src/lib/store";

/* ImageData does not exist in Node; the CV code only needs the shape. */
class ImageDataShim {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c!;
    }
  }
}
(globalThis as unknown as { ImageData: typeof ImageDataShim }).ImageData = ImageDataShim;

/**
 * The high-resolution sibling of the demo photo, written by `make-sample.ts`.
 *
 * A phone hands the app a 3600px photo; the shipped demo is 2400px because it is
 * precached for offline use. The README shows what the app does with a real
 * photo, so it is built from the big one.
 */
const SOURCE = ".tmp/letter-hi.jpg";
/** The page is rendered at this long side — the export size, not a preview. */
const AFTER_SIDE = 2200;
/** The camera photo is scaled down to this, so the two images match in width. */
const BEFORE_SIDE = 1400;

const raw = jpeg.decode(readFileSync(SOURCE), { useTArray: true });
const photo = new ImageDataShim(
  new Uint8ClampedArray(raw.data),
  raw.width,
  raw.height
) as unknown as ImageData;

const encode = (img: ImageData, quality: number) =>
  jpeg.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, quality).data;

/** Box-average downscale, the same idea as the app's import path. */
function fit(img: ImageData, longSide: number): ImageData {
  const scale = Math.min(1, longSide / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  if (w === img.width && h === img.height) return img;
  const out = new ImageDataShim(w, h) as unknown as ImageData;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

const quad = detectPageQuad(photo);
if (!quad) {
  console.error("no page found in the demo photo — the README images would be wrong");
  process.exit(1);
}
// exactly what the app crops with (store.EDGE_INSET), so the picture is the app
const crop = insetQuad(quad, EDGE_INSET);
const size = outputSize(crop, AFTER_SIDE);
const straight = warp(photo, crop, size.w, size.h);
// exactly what the Optimize switch does, from the same constant the app uses
const page = enhance(straight, OPTIMIZE);

/**
 * A detail crop at 100%, not a blow-up.
 *
 * The pair is displayed at half the README width, so a crop of the scanned page
 * arrives on screen at roughly its own pixel size — which is the only honest way
 * to judge it. A 2× enlargement used to be necessary because the source page was
 * 600px wide; now it would only magnify antialiasing.
 */
function detail(img: ImageData, x0: number, y0: number, x1: number, y1: number, scale: number) {
  const sx = Math.round(x0 * img.width);
  const sy = Math.round(y0 * img.height);
  const sw = Math.round((x1 - x0) * img.width);
  const sh = Math.round((y1 - y0) * img.height);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const out = new ImageDataShim(w, h) as unknown as ImageData;
  for (let y = 0; y < h; y++) {
    const fy = sy + (y + 0.5) / scale - 0.5;
    const y0i = Math.max(0, Math.min(img.height - 1, Math.floor(fy)));
    const y1i = Math.min(img.height - 1, y0i + 1);
    const ty = Math.max(0, Math.min(1, fy - y0i));
    for (let x = 0; x < w; x++) {
      const fx = sx + (x + 0.5) / scale - 0.5;
      const x0i = Math.max(0, Math.min(img.width - 1, Math.floor(fx)));
      const x1i = Math.min(img.width - 1, x0i + 1);
      const tx = Math.max(0, Math.min(1, fx - x0i));
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = img.data[(y0i * img.width + x0i) * 4 + c];
        const b = img.data[(y0i * img.width + x1i) * 4 + c];
        const d = img.data[(y1i * img.width + x0i) * 4 + c];
        const e = img.data[(y1i * img.width + x1i) * 4 + c];
        out.data[o + c] = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

mkdirSync("docs", { recursive: true });
/**
 * The same region twice, at 2×: the straightened photo, and what Optimize makes
 * of it. One look at this pair says more about the pipeline than any paragraph.
 */
/**
 * The strip the README shows, sized so GitHub renders it at 1:1.
 *
 * A README column is about 880px wide. Displaying a 1554px page there throws a
 * third of the pixels away and re-softens every glyph — which is how a genuinely
 * sharp scan ends up looking blurry in a screenshot. This crop is ~880px wide, so
 * what a reader sees is the pipeline's own output, pixel for pixel.
 */
const REGION: [number, number, number, number] = [0.05, 0.06, 0.57, 0.28];
const close = detail(page, ...REGION, 1);
// the photographed version, cut from the *straightened* page so the two line up
const closeBefore = detail(straight, ...REGION, 1);
writeFileSync("docs/detail.jpg", encode(close, 92));
writeFileSync("docs/detail-before.jpg", encode(closeBefore, 92));
writeFileSync("docs/before.jpg", encode(fit(photo, BEFORE_SIDE), 84));
writeFileSync("docs/after.jpg", encode(page, 92));
console.log(
  `docs/detail.jpg + docs/detail-before.jpg ${close.width}×${close.height}\ndocs/before.jpg ${Math.min(BEFORE_SIDE, photo.width)}px · docs/after.jpg ${page.width}×${page.height} (${Math.round(
    encode(page, 86).length / 1024
  )} kB)`
);
