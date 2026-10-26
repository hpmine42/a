import { readFileSync, writeFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { detectPageQuad, enhance, fullFrameQuad, outputSize, warp } from "../src/cv";

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
(globalThis as any).ImageData = ImageDataShim;

const raw = jpeg.decode(readFileSync("public/samples/letter.jpg"), { useTArray: true });
const src = new ImageDataShim(new Uint8ClampedArray(raw.data), raw.width, raw.height) as ImageData;
console.log(`source ${src.width}x${src.height}`);

const t0 = Date.now();
const quad = detectPageQuad(src);
console.log("detect ms:", Date.now() - t0);
console.log("quad:", quad ? quad.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" | ") : "NULL");
if (!quad) process.exit(1);

const q = quad ?? fullFrameQuad(src.width, src.height);
const size = outputSize(q, 1600);
const t1 = Date.now();
const warped = warp(src, q, size.w, size.h);
console.log("warp ms:", Date.now() - t1, `-> ${size.w}x${size.h}`);

const t2 = Date.now();
for (const mode of ["bw", "gray"] as const) {
  const out = enhance(warped, { mode, brightness: 0, contrast: 0, strength: 55 });
  // ink ratio = share of dark pixels, a decent proxy for "did we threshold sanely"
  let dark = 0;
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i] < 128) dark++;
  const ratio = dark / (out.width * out.height);
  console.log(`${mode}: ${Date.now() - t2}ms ink=${(ratio * 100).toFixed(2)}%`);
  const enc = jpeg.encode({ data: Buffer.from(out.data), width: out.width, height: out.height }, 88);
  writeFileSync(`.tmp/out-${mode}.jpg`, enc.data);
}
// draw quad overlay onto the source for visual QA
{
  const d = new Uint8ClampedArray(src.data);
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / steps);
      const y = Math.round(a.y + ((b.y - a.y) * i) / steps);
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
        const px = x + ox, py = y + oy;
        if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
        const o = (py * src.width + px) * 4;
        d[o] = 255; d[o + 1] = 140; d[o + 2] = 0;
      }
    }
  };
  for (let i = 0; i < 4; i++) line(q[i], q[(i + 1) % 4]);
  writeFileSync(".tmp/quad.jpg", jpeg.encode({ data: Buffer.from(d), width: src.width, height: src.height }, 88).data);
}
const encW = jpeg.encode({ data: Buffer.from(warped.data), width: warped.width, height: warped.height }, 88);
writeFileSync(".tmp/out-warped.jpg", encW.data);
