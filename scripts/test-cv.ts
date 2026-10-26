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
/** Corners measured by hand on the demo photo: TL, TR, BR, BL. */
const EXPECTED = [
  { x: 300, y: 160 },
  { x: 790, y: 78 },
  { x: 990, y: 700 },
  { x: 395, y: 838 },
];
const TOLERANCE = 90;

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

console.log(`\nflatbed · cv smoke test\n  source ${src.width}×${src.height}\n`);

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

// Keep the visual artefacts around for manual eyeballing; CI ignores them.
mkdirSync(".tmp", { recursive: true });
const write = (name: string, img: ImageData) =>
  writeFileSync(
    `.tmp/${name}.jpg`,
    jpeg.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, 86).data
  );
write("out-bw", bw);
write("out-gray", gray);
write("out-warped", warped);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
