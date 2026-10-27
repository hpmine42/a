/**
 * Headless smoke test for the CV pipeline.
 *
 * Runs paper detection, the perspective warp and both enhancement modes on the
 * demo photo and asserts the result is actually usable. This is what CI runs,
 * so a regression in the detector fails the build instead of shipping.
 *
 *   npm run test:cv
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { detectPageQuad, enhance, outputSize, warp } from "../src/lib/cv";

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

const SOURCE = "public/samples/letter.jpg";
/**
 * Corners measured on the demo photo by scanning the paper/desk boundary
 * column by column (TL, TR, BR, BL). The earlier numbers were eyeballed, and a
 * 35px error in one corner was quietly tolerated for several rounds.
 */
const EXPECTED = [
  { x: 300, y: 160 },
  { x: 756, y: 86 },
  { x: 980, y: 700 },
  { x: 397, y: 838 },
];
/** Tightened after round 12: the detector now lands within a few pixels on this
 *  photo, and a loose tolerance is what let a 50px crop error ship unnoticed. */
const TOLERANCE = 25;

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const raw = jpeg.decode(readFileSync(SOURCE), { useTArray: true });
const src = new ImageDataShim(
  new Uint8ClampedArray(raw.data),
  raw.width,
  raw.height
) as unknown as ImageData;

console.log(`\nScano · cv smoke test\n  source ${src.width}×${src.height}\n`);

const t0 = performance.now();
const quad = detectPageQuad(src);
const detectMs = performance.now() - t0;

check("detects a page", quad !== null, quad ? "" : "no quad found");

if (!quad) {
  console.log("\n1 check failed\n");
  process.exit(1);
}

const worst = Math.max(
  ...quad.map((p, i) => Math.hypot(p.x - EXPECTED[i].x, p.y - EXPECTED[i].y))
);
check(
  "corners within tolerance",
  worst <= TOLERANCE,
  `worst corner off by ${Math.round(worst)}px (limit ${TOLERANCE})`
);
check("detection is fast", detectMs < 900, `${Math.round(detectMs)}ms`);

const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const aspect = Math.max(d(quad[0], quad[1]), d(quad[1], quad[2])) /
  Math.min(d(quad[0], quad[1]), d(quad[1], quad[2]));
check("page is roughly portrait", aspect > 0.9 && aspect < 1.9, `aspect ${aspect.toFixed(2)}`);

const size = outputSize(quad, 1600);
const warped = warp(src, quad, size.w, size.h);
check("warp produces an image", warped.width > 300 && warped.height > 300, `${warped.width}×${warped.height}`);

const inkRatio = (img: ImageData) => {
  let dark = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) dark++;
  return dark / (img.width * img.height);
};

const bw = enhance(warped, { mode: "bw", brightness: 0, contrast: 0, strength: 55 });
const bwInk = inkRatio(bw);
check("B&W keeps text and clears paper", bwInk > 0.005 && bwInk < 0.2, `ink ${(bwInk * 100).toFixed(2)}%`);

const gray = enhance(warped, { mode: "gray", brightness: 0, contrast: 0, strength: 55 });
check("grayscale renders", gray.width === warped.width, `${gray.width}×${gray.height}`);

const colour = enhance(warped, { mode: "color", brightness: 0, contrast: 0, strength: 55 });
// a page is mostly paper: after normalisation the average luma has to be high,
// otherwise the output looks grey and dirty rather than scanned
const meanLuma = (img: ImageData) => {
  let sum = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  return sum / (img.width * img.height);
};
const paper = meanLuma(bw);
check("B&W paper is actually white", paper > 205, `mean luma ${paper.toFixed(0)}`);

/**
 * Soft coverage, not a stamp.
 *
 * A threshold makes every glyph solid black — which is what turned "rn" into "m"
 * and made the scans look like a 1995 photocopier. A scan of printed text has
 * grey pixels along every edge, so a healthy page has a visible band of them.
 * If they ever disappear, the pipeline went back to stamping.
 */
const softness = (img: ImageData) => {
  let mid = 0;
  let inked = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i];
    // "inked" = anything that is not paper; "mid" = the antialiased rim of it
    if (v < 210) inked++;
    if (v > 60 && v < 195) mid++;
  }
  return inked ? mid / inked : 0;
};
const soft = softness(bw);
check(
  "letter edges keep their grey",
  soft > 0.2,
  `${(soft * 100).toFixed(0)}% of the ink is mid-tone`
);
check("colour renders", colour.width === warped.width, `${colour.width}×${colour.height}`);

// Keep the visual artefacts around for manual eyeballing; CI ignores them.
mkdirSync(".tmp", { recursive: true });
const write = (name: string, img: ImageData) =>
  writeFileSync(
    `.tmp/${name}.jpg`,
    jpeg.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, 86).data
  );
write("out-bw", bw);
write("out-gray", gray);
write("out-colour", colour);
write("out-warped", warped);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
