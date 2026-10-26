import { markRaw, reactive } from "vue";
import {
  detectPageQuad,
  enhance,
  fullFrameQuad,
  insetQuad,
  outputSize,
  warp,
  type EnhanceOpts,
  type Mode,
  type Quad,
} from "./cv";
import { makeThumb, nextFrame } from "./image";

export type Opts = Required<EnhanceOpts>;

export type Page = {
  id: number;
  name: string;
  src: ImageData;
  quad: Quad;
  warped: ImageData | null;
  result: ImageData | null;
  thumb: string | null;
  opts: Opts;
};

/**
 * Resolution budgets.
 *
 * `IMPORT_MAX` is what a picked photo or a captured frame is read at — phone
 * cameras produce 4000px wide images, and throwing that away at import is what
 * made crops look soft. `PREVIEW_MAX` is the on-screen render (sharp on a 3x
 * phone screen without spending 30MB per page). `EXPORT_MAX` is the PDF.
 */
export const IMPORT_MAX = 3600;
export const PREVIEW_MAX = 2400;
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

export const defaultOpts = (): Opts => ({
  mode: "bw",
  brightness: 0,
  contrast: 0,
  strength: 55,
});

export const activePage = (): Page | null =>
  scan.pages.find((p) => p.id === scan.activeId) ?? null;

export function addPage(src: ImageData, name = "scan"): Page {
  const page: Page = {
    id: nextId++,
    name,
    src: markRaw(src),
    quad: fullFrameQuad(src.width, src.height),
    warped: null,
    result: null,
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
  return true;
}

function safeDetect(img: ImageData): Quad | null {
  try {
    return detectPageQuad(img, { effort: "thorough" });
  } catch (err) {
    console.warn("[scanner] detection failed", err);
    return null;
  }
}

/**
 * Warp + enhance the active page. `full` also refreshes the thumbnail;
 * `rewriteWarp` is needed whenever the quad changed.
 */
export async function processPage(
  page: Page,
  { full = false, rewriteWarp = false }: { full?: boolean; rewriteWarp?: boolean } = {}
): Promise<void> {
  await nextFrame();
  const maxSide = full ? PREVIEW_MAX : 900;
  if (!page.warped || rewriteWarp) {
    // the crop is pulled in a hair: both detection and hand-placed corners tend
    // to sit just outside the paper, and that shows up as a dark desk edge
    const quad = insetQuad(page.quad, 0.005);
    const size = outputSize(quad, maxSide);
    page.warped = markRaw(warp(page.src, quad, size.w, size.h));
  }
  page.result = markRaw(enhance(page.warped, page.opts));
  if (full) page.thumb = makeThumb(page.result);
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

export function applyOptsToAll(opts: Opts): void {
  for (const page of scan.pages) {
    page.opts = { ...opts };
    page.warped = null;
  }
}

export type { Mode, Quad };
