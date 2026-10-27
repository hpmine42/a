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

/**
 * Turn a page a quarter turn clockwise. Kept pure (no canvas) so the maths is
 * testable: a rotation that is off by one row shows up as a one-pixel stripe of
 * the desk along an edge of every exported page.
 */
export function rotateImageData(img: ImageData, quarter: number): ImageData {
  const q = ((Math.round(quarter) % 4) + 4) % 4;
  if (!q) return img;
  const w = img.width;
  const h = img.height;
  const swap = q % 2 === 1;
  const out = new ImageData(swap ? h : w, swap ? w : h);
  const src = img.data;
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number;
      let dy: number;
      if (q === 1) {
        dx = h - 1 - y;
        dy = x;
      } else if (q === 2) {
        dx = w - 1 - x;
        dy = h - 1 - y;
      } else {
        dx = y;
        dy = w - 1 - x;
      }
      const from = (y * w + x) * 4;
      const to = (dy * out.width + dx) * 4;
      dst[to] = src[from];
      dst[to + 1] = src[from + 1];
      dst[to + 2] = src[from + 2];
      dst[to + 3] = src[from + 3];
    }
  }
  return out;
}

/**
 * Can this file be a photo?
 *
 * `accept="image/*"` guarantees nothing: iPhone HEIC files reach the picker with
 * an empty MIME type on many Android builds, and a strict `type.startsWith`
 * filter then swallowed the whole selection — the picker closed and the app did
 * nothing at all. The extension is the second opinion.
 */
const PHOTO_EXT = /\.(jpe?g|png|webp|heic|heif|avif|gif|bmp|tiff?|dng)$/i;

export function looksLikePhoto(file: { type: string; name: string }): boolean {
  if (file.type.startsWith("image/")) return true;
  return (file.type === "" || file.type === "application/octet-stream") && PHOTO_EXT.test(file.name);
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

/**
 * A canvas as a JPEG blob.
 *
 * The OCR engine reads a file, and a JPEG of a scanned page is a tenth of the
 * PNG it would otherwise encode — which matters when the whole thing is handed
 * to a worker on a phone.
 */
export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/jpeg",
  quality = 0.94
): Promise<Blob | null> {
  if (typeof canvas.toBlob !== "function") return null;
  return new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
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
