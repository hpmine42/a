import { markRaw, reactive } from "vue";
import {
  detectPageQuad,
  enhance,
  fullFrameQuad,
  insetQuad,
  outputSize,
  warp,
  type Mode,
  type Quad,
} from "./cv";
import { makeThumb, nextFrame } from "./image";

/**
 * What a page looks like. One decision, not a control panel: Optimize is either
 * on (flattened light, black text on white paper) or off (the photo as taken).
 */
export type Opts = {
  optimize: boolean;
};

export type Page = {
  id: number;
  name: string;
  src: ImageData;
  quad: Quad;
  warped: ImageData | null;
  /** Resolution `warped` was rendered at — a preview must not be mistaken for
   *  the final render when the crop changes. */
  warpedSide: number;
  result: ImageData | null;
  /** The un-optimised render, kept so toggling Optimize is instant. */
  original: ImageData | null;
  /** Which resolution+look `result` currently holds. */
  cacheKey: string;
  thumb: string | null;
  opts: Opts;
};

/**
 * Resolution budgets. Imports keep almost everything the camera gave us;
 * previews are sharp on a 3x phone screen; exports are 300 DPI at A4.
 */
export const IMPORT_MAX = 3600;
export const PREVIEW_MAX = 2400;
/** While the crop tool is open the preview is only needed small. */
export const CROP_MAX = 1200;
export const EXPORT_MAX = 3000;

export const scan = reactive({
  pages: [] as Page[],
  activeId: 0,
  /** Paper size for the exported PDF. */
  format: "a4" as "a4" | "letter" | "fit",
  /** What the exported file is called, without the extension. */
  filename: "",
});

let nextId = 1;

/** Optimize starts on: a photographed page is never finished until it is one. */
export const defaultOpts = (): Opts => ({ optimize: true });

export const activePage = (): Page | null =>
  scan.pages.find((p) => p.id === scan.activeId) ?? null;

export function addPage(src: ImageData, name = "scan"): Page {
  const page: Page = {
    id: nextId++,
    name,
    src: markRaw(src),
    quad: fullFrameQuad(src.width, src.height),
    warped: null,
    warpedSide: 0,
    result: null,
    original: null,
    cacheKey: "",
    thumb: null,
    opts: defaultOpts(),
  };
  scan.pages.push(page);
  scan.activeId = page.id;
  return page;
}

/** Detect the sheet in a photo and store the result on the page. */
export function autoDetect(page: Page): boolean {
  const quad = safeDetect(page.src);
  if (!quad) return false;
  page.quad = quad;
  page.warped = null;
  page.warpedSide = 0;
  return true;
}

function safeDetect(img: ImageData): Quad | null {
  try {
    return detectPageQuad(img, { effort: "thorough" });
  } catch (err) {
    console.warn("[scano] detection failed", err);
    return null;
  }
}

/** The mode passed to the pipeline. Optimize means B&W, otherwise colour. */
export const modeFor = (opts: Opts): Mode => (opts.optimize ? "bw" : "color");

export type ProcessOptions = {
  /** Refresh the thumbnail too (only worth it when the page is finished). */
  full?: boolean;
  /** The crop changed, so the warp has to be redone. */
  rewriteWarp?: boolean;
  /** Long side of the preview. */
  maxSide?: number;
  /** Re-render even when nothing but the look changed. */
  force?: boolean;
};

/**
 * Warp + enhance a page.
 *
 * Two caches make the editor feel instant:
 *  - the warp is reused while the crop and the requested resolution are the
 *    same, so toggling Optimize costs one enhance pass, not a warp too;
 *  - an enhance pass already made for this exact combination is kept, so
 *    toggling back and forth is free.
 */
export async function processPage(page: Page, opts: ProcessOptions = {}): Promise<void> {
  const { full = false, rewriteWarp = false, force = false } = opts;
  const maxSide = opts.maxSide ?? (full ? PREVIEW_MAX : 900);
  const key = `${maxSide}:${page.opts.optimize ? "opt" : "orig"}`;

  if (!force && page.result && page.warped && page.warpedSide === maxSide && page.cacheKey === key) {
    if (full && !page.thumb) page.thumb = makeThumb(page.result);
    return;
  }

  await nextFrame();

  if (!page.warped || rewriteWarp || page.warpedSide !== maxSide) {
    // pulled in a hair: detection and hand-placed corners both tend to sit just
    // outside the paper, and that sliver of desk becomes a dark edge
    const quad = insetQuad(page.quad, 0.005);
    const size = outputSize(quad, maxSide);
    page.warped = markRaw(warp(page.src, quad, size.w, size.h));
    page.warpedSide = maxSide;
    page.original = null;
  }

  const mode = modeFor(page.opts);
  if (mode === "color" && page.original) {
    page.result = page.original;
  } else {
    page.result = markRaw(enhance(page.warped, { mode, brightness: 0, contrast: 0, strength: 58 }));
    if (mode === "color") page.original = page.result;
  }
  page.cacheKey = key;
  if (full) page.thumb = makeThumb(page.result);
}

/** Flip Optimize and re-render at the current preview resolution. */
export function toggleOptimize(page: Page): void {
  page.opts.optimize = !page.opts.optimize;
}

export function removePage(id: number): void {
  const index = scan.pages.findIndex((p) => p.id === id);
  if (index === -1) return;
  scan.pages.splice(index, 1);
  if (scan.activeId === id) {
    scan.activeId = scan.pages[Math.min(index, scan.pages.length - 1)]?.id ?? 0;
  }
}

export function clearPages(): void {
  scan.pages.splice(0, scan.pages.length);
  scan.activeId = 0;
}

export type { Mode, Quad };
