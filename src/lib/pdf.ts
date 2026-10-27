import type { jsPDF as JsPdf } from "jspdf";
import { enhance, insetQuad, outputSize, warp } from "./cv";
import { imageDataToCanvas, nextFrame, rotateImageData, slug } from "./image";
import { EDGE_INSET, EXPORT_MAX, ensureSource, naturalSide, type Page } from "./store";

export type PageFormat = "a4" | "letter" | "fit";

export type Progress = (done: number, total: number) => void;

type Box = { width: number; height: number };

/** Page sizes in millimetres. `fit` is derived from the image itself. */
const PAPER: Record<Exclude<PageFormat, "fit">, Box> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 },
};

/**
 * Where an image of the given pixel size lands on a page of `paper` size.
 * Pure and unit-tested: getting this wrong prints cropped documents.
 */
export function fitOnPage(
  imageW: number,
  imageH: number,
  paper: Box
): { x: number; y: number; width: number; height: number; orientation: "portrait" | "landscape"; size: Box } {
  const landscape = imageW > imageH;
  // rotate the sheet so the image gets the most usable area
  const size = landscape
    ? { width: paper.height, height: paper.width }
    : { width: paper.width, height: paper.height };

  const margin = Math.min(size.width, size.height) * 0.04;
  const boxW = size.width - margin * 2;
  const boxH = size.height - margin * 2;
  const ratio = imageW / imageH;

  let width = boxW;
  let height = boxW / ratio;
  if (height > boxH) {
    height = boxH;
    width = boxH * ratio;
  }
  return {
    x: (size.width - width) / 2,
    y: (size.height - height) / 2,
    width,
    height,
    orientation: landscape ? "landscape" : "portrait",
    size,
  };
}

/**
 * Turn what the user typed into a safe file name. Kept pure so the naming rules
 * are testable: no path separators, no characters Windows rejects, always ends
 * in `.pdf`, and a sensible fallback for an empty field.
 */
export function pdfFilename(input: string, pages: number): string {
  const base =
    input
      .trim()
      // strip an extension the user typed by habit
      .replace(/\.pdf$/i, "")
      // characters that break a download or a filesystem
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/^[.\s-]+|[.\s-]+$/g, "")
      .slice(0, 80) || (pages === 1 ? "Scano scan" : `Scano scan ${pages} pages`);
  return `${base}.pdf`;
}

/**
 * The biggest canvas this is allowed to ask for.
 *
 * iOS Safari silently returns a blank canvas past roughly 16.7M pixels and has
 * historically refused anything over 4096 on one side; Android is not
 * unlimited either. A6 at 300 DPI is ~8.7M, so the cap sits just under the line
 * and a page that would cross it is rendered a little smaller rather than
 * coming out empty.
 */
export const MAX_CANVAS_PX = 8_000_000;
export const MAX_CANVAS_DIM = 4096;

/** Shrink a render size until every browser will actually draw it. */
export function safeCanvasSize(w: number, h: number): { w: number; h: number } {
  let scale = 1;
  if (w * h > MAX_CANVAS_PX) scale = Math.sqrt(MAX_CANVAS_PX / (w * h));
  const long = Math.max(w, h) * scale;
  if (long > MAX_CANVAS_DIM) scale *= MAX_CANVAS_DIM / long;
  if (scale >= 1) return { w, h };
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export type BuiltPdf = { blob: Blob; filename: string };

/** Why an export could not be produced — the UI says which, in plain words. */
export type ExportReason =
  /** The jsPDF chunk never arrived (offline, or a stale index.html). */
  | "engine"
  /** A page produced no pixels: a canvas past the browser's limit, or a photo
   *  that never decoded. */
  | "render";

export class ExportError extends Error {
  constructor(readonly reason: ExportReason) {
    super(reason === "engine" ? "PDF engine unavailable" : "a page produced no pixels");
    this.name = "ExportError";
  }
}

let engine: Promise<typeof import("jspdf")> | null = null;

/**
 * Load jsPDF once, on demand — and early, if anyone offers.
 *
 * The chunk is 370 kB that nobody needs until they export, but a lazy chunk is
 * also a chunk that is *not in the cache* when the phone is offline or on a
 * flaky connection, and then both Save and Share fail with a shrug. So the app
 * asks for it while the user is busy pointing the camera at things, and this
 * function keeps a single promise so a tap never waits twice.
 */
export function preloadPdf(): Promise<typeof import("jspdf")> {
  if (!engine) {
    engine = import("jspdf").catch((err) => {
      // a failed chunk is cached as a failure for that specifier, so let the
      // next call create a fresh promise instead of remembering the failure
      engine = null;
      throw err;
    });
  }
  return engine;
}

/**
 * Warm the engine in the background, unless the user is on a connection they
 * would rather not spend (Data Saver, or a 2G link). The camera and the editor
 * work completely offline without it; only exporting needs it, and by then it is
 * in the cache.
 */
export function preloadPdfWhenIdle(): void {
  try {
    const conn = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (conn?.saveData) return;
    if (conn?.effectiveType && /(^|-)2g$/.test(conn.effectiveType)) return;
  } catch {
    /* no Network Information API: assume a normal connection */
  }
  const run = () => void preloadPdf().catch(() => undefined);
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 4000 });
  } else {
    window.setTimeout(run, 1500);
  }
}

async function loadEngine(): Promise<typeof import("jspdf")> {
  try {
    return await preloadPdf();
  } catch {
    throw new ExportError("engine");
  }
}

/**
 * A canvas that could not be drawn to does not throw — it returns "data:," or an
 * empty string. jsPDF accepts that happily and prints blank pages, which is
 * worse than failing, so an export checks what it got and renders smaller.
 */
export function isUsableImageUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith("data:image/") && url.length > 512;
}

/**
 * How much of the 3000px budget a page gets, by document size.
 *
 * One page gets everything. A twenty-page export gets 55% — around 1650px on
 * the long side, which still prints above 200 DPI on A4 — because the failure
 * mode past that is not a slightly softer page, it is the tab being killed
 * halfway through the export.
 */
export function pageBudgetScale(pages: number): number {
  if (pages <= 4) return 1;
  if (pages <= 8) return 0.8;
  if (pages <= 14) return 0.68;
  return 0.55;
}

/** A page smaller than this is not a scan, it is a broken canvas. */
const MIN_JPEG_BYTES = 512;

function base64ToBytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Blob → bytes, with the FileReader path for browsers without `arrayBuffer`. */
async function blobToBytes(blob: Blob): Promise<Uint8Array | null> {
  if (typeof blob.arrayBuffer === "function") {
    try {
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      /* fall through */
    }
  }
  if (typeof FileReader === "function") {
    return await new Promise<Uint8Array | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(blob);
    });
  }
  return null;
}

/**
 * A page as JPEG bytes.
 *
 * Bytes rather than a base64 string: the string form costs a third more memory
 * and another full copy inside jsPDF, and a phone exporting twenty pages is
 * exactly where that adds up. `toBlob` also reports failure honestly — it hands
 * back null, where `toDataURL` invents "data:," — so the caller can retry
 * smaller instead of printing a blank sheet.
 */
async function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((result) => resolve(result), "image/jpeg", quality);
      } catch {
        resolve(null);
      }
    });
    if (blob && blob.size >= MIN_JPEG_BYTES) {
      const bytes = await blobToBytes(blob);
      if (bytes && bytes.length >= MIN_JPEG_BYTES) return bytes;
    }
    if (blob === null) return null;
  }
  // Older browsers (and the test stubs) only have the data URL
  const url = canvas.toDataURL("image/jpeg", quality);
  return isUsableImageUrl(url) ? base64ToBytes(url) : null;
}

/**
 * One page as a JPEG, shrinking until the browser actually drew something.
 *
 * Every buffer in here is local: a 3000px page is ~30 MB of RGBA, and holding a
 * few of those alive while jsPDF keeps its own copies is how a phone runs out of
 * memory mid-export. Going smaller on failure is the honest trade — a slightly
 * smaller page beats "Export failed".
 */
async function renderPage(
  page: Page,
  /** How many pages the document has — the pixel budget is shared between them. */
  count: number
): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  // A page restored from storage but never decoded carries a 1x1 placeholder.
  // Warping that produces a convincing black rectangle, so say what happened.
  if (page.src.width < 8 || page.src.height < 8) throw new ExportError("render");
  const quad = insetQuad(page.quad, EDGE_INSET);
  // never scale a page above what the photo has: invented pixels cost file
  // size and buy nothing a reader can see
  // Twenty pages at full size is half a gigabyte of transient RGBA on a phone.
  // Spend the pixels where they can be seen: fewer, still sharp pages.
  const side = Math.max(900, Math.round(Math.min(EXPORT_MAX, naturalSide(page)) * pageBudgetScale(count)));
  const size = outputSize(quad, side);
  // A collapsed crop has no area to render: ImageData refuses zero width, and
  // guessing a size would only move the failure somewhere less obvious.
  if (size.w < 2 || size.h < 2) throw new ExportError("render");
  // An optimised page is black text on paper: it survives 0.9 untouched and
  // saves a third of the file. A photo keeps 0.95 — that is where it shows.
  const quality = page.opts.optimize ? 0.9 : 0.95;

  for (const factor of [1, 0.72, 0.5]) {
    try {
      const attempt = safeCanvasSize(
        Math.max(2, Math.round(size.w * factor)),
        Math.max(2, Math.round(size.h * factor))
      );
      const warped = warp(page.src, quad, attempt.w, attempt.h);
      const upright = rotateImageData(warped, page.rotation / 90);
      // Optimize off means untouched: the straight photo, nothing applied
      const result = page.opts.optimize
        ? enhance(upright, { mode: "bw", brightness: 0, contrast: 0, strength: 58 })
        : upright;
      const jpeg = await canvasToJpeg(imageDataToCanvas(result), quality);
      if (jpeg) return { jpeg, width: result.width, height: result.height };
    } catch (err) {
      // Out of memory, a canvas the browser refuses, a decode that went wrong:
      // the next, smaller attempt is the best answer available from here.
      console.warn("[scano] a page failed to render, trying smaller", err);
    }
  }
  // Nothing came out at any size: the page has no usable pixels. Failing with a
  // reason beats printing a black sheet and calling it a scan.
  throw new ExportError("render");
}

/**
 * Build the PDF in memory. Separate from saving it, because a phone has two
 * very different ways of getting rid of it: a download, or the share sheet
 * (which is what people actually use — straight to mail, chat or Drive).
 */
export async function buildPdf(
  pages: Page[],
  format: PageFormat = "a4",
  onProgress?: Progress,
  /** Base name for the file, without `.pdf`. */
  name = ""
): Promise<BuiltPdf> {
  const { jsPDF } = await loadEngine();
  let doc: JsPdf | null = null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    onProgress?.(i, pages.length);
    await nextFrame();
    // a page restored from the last session may still be decoding
    await ensureSource(page);

    const { jpeg, width, height } = await renderPage(page, pages.length);

    const paper =
      format === "fit"
        ? { width: (width * 25.4) / 200, height: (height * 25.4) / 200 }
        : PAPER[format];
    const place = fitOnPage(width, height, paper);

    if (!doc) {
      doc = new jsPDF({
        unit: "mm",
        format: format === "fit" ? [place.size.width, place.size.height] : format,
        orientation: place.orientation,
        compress: true,
      });
    } else {
      doc.addPage(
        format === "fit" ? [place.size.width, place.size.height] : format,
        place.orientation
      );
    }

    doc.addImage(jpeg, "JPEG", place.x, place.y, place.width, place.height, undefined, "SLOW");
  }

  onProgress?.(pages.length, pages.length);
  const filename =
    name.trim() || (pages.length === 1 ? slug(pages[0].name) : "");
  const safe = pdfFilename(filename, pages.length);
  return { blob: doc ? doc.output("blob") : new Blob(), filename: safe };
}

/** Build and hand the file to the browser's download machinery. */
export async function exportPdf(
  pages: Page[],
  format: PageFormat = "a4",
  onProgress?: Progress,
  name = ""
): Promise<string> {
  const { blob, filename } = await buildPdf(pages, format, onProgress, name);
  downloadBlob(blob, filename);
  return filename;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari needs a beat before the object URL goes away
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
