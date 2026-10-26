// Small DOM-side image helpers shared by the camera, the editor and the export.

export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export function imageDataToCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}

/** Draw a bitmap into a canvas, capped on the long side, and read it back. */
export function bitmapToImageData(bmp: ImageBitmap | HTMLVideoElement, maxSide: number): ImageData {
  const w0 = bmp instanceof HTMLVideoElement ? bmp.videoWidth : bmp.width;
  const h0 = bmp instanceof HTMLVideoElement ? bmp.videoHeight : bmp.height;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp as CanvasImageSource, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

export async function imageDataFromFile(file: File, maxSide = 2600): Promise<ImageData> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    return bitmapToImageData(bmp, maxSide);
  } finally {
    bmp.close?.();
  }
}

/** Centre crop by a zoom factor — mirrors what a CSS-scaled preview shows. */
export function cropRegion(img: ImageData, factor: number): ImageData {
  const f = Math.max(1, factor);
  const w = Math.max(1, Math.round(img.width / f));
  const h = Math.max(1, Math.round(img.height / f));
  const x = Math.round((img.width - w) / 2);
  const y = Math.round((img.height - h) / 2);
  const out = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    out.data.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

/** A thumbnail data URL for the filmstrip and the page grid. */
export function makeThumb(img: ImageData, w = 240, h = 320): string {
  const scale = Math.min(w / img.width, h / img.height);
  const tw = Math.max(1, Math.round(img.width * scale));
  const th = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = tw;
  c.height = th;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  // the cached canvas is also what the editor draws, so a thumbnail costs a
  // draw, not another page-sized allocation
  ctx.drawImage(canvasFor(img), 0, 0, tw, th);
  return c.toDataURL("image/jpeg", 0.72);
}

export function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "scan"
  );
}

const canvasCache = new WeakMap<ImageData, HTMLCanvasElement>();

/** Cache one canvas per ImageData so redraws stay cheap. */
export function canvasFor(img: ImageData): HTMLCanvasElement {
  const hit = canvasCache.get(img);
  if (hit) return hit;
  const c = imageDataToCanvas(img);
  canvasCache.set(img, c);
  return c;
}

export type Fit = { scale: number; dx: number; dy: number };

export function containFit(imgW: number, imgH: number, boxW: number, boxH: number): Fit {
  const scale = Math.min(boxW / imgW, boxH / imgH);
  return { scale, dx: (boxW - imgW * scale) / 2, dy: (boxH - imgH * scale) / 2 };
}
