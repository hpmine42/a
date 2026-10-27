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
import {
  bitmapToImageData,
  imageDataToCanvas,
  makeThumb,
  nextFrame,
  rotateImageData,
} from "./image";
import { projectStore, type StoredMeta, type StoredPage } from "./storage";

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
  /** The photo as a file, so a reload can put the page back on screen. */
  srcBlob: Blob | null;
  /**
   * Set while a restored page is still being decoded. `src` holds a 1x1
   * placeholder until `ensureSource` resolves — the grid only needs the thumb,
   * and decoding ten 3600px photos at launch is a second of blank screen.
   */
  pending: Promise<ImageData> | null;
  /** Quarter turns applied at render time. */
  rotation: number;
  quad: Quad;
  warped: ImageData | null;
  /** Resolution `warped` was rendered at — a preview must not be mistaken for
   *  the final render when the crop changes. */
  warpedSide: number;
  result: ImageData | null;
  /** Which resolution+look `result` currently holds. */
  cacheKey: string;
  thumb: string | null;
  opts: Opts;
  /**
   * The page *is* the photo: "Keep the whole photo" means no crop at all, so the
   * usual hairline inset (which cleans up the desk edge a detector leaves) is
   * switched off for it. Otherwise the label lies by ~3% per edge, and text that
   * runs to the paper's edge loses its first letters.
   */
  whole: boolean;
};

/**
 * Resolution budgets. Imports keep almost everything the camera gave us;
 * previews are sharp on a 3x phone screen; exports are 300 DPI at A4.
 */
export const IMPORT_MAX = 3600;
export const PREVIEW_MAX = 2400;
/** The first look after a shot: sharp on screen, cheap enough to feel instant. */
export const FIRST_RENDER = 1400;
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

/**
 * Optimize starts *off*: the photo as taken is the honest starting point, and
 * the switch is one tap away for anyone who wants flat, white, black-on-white.
 */
export const defaultOpts = (): Opts => ({ optimize: false });

/**
 * How far the crop is pulled in, as a fraction of the page. Detection and
 * hand-placed corners both tend to sit a few pixels outside the paper, and that
 * sliver of desk becomes a dirty edge on every page.
 */
export const EDGE_INSET = 0.008;

/**
 * The largest a page can be from its source photo — rendering past this only
 * invents pixels, and a page that is upscaled from a small import looks soft
 * no matter how sharp the pipeline is.
 */
export function naturalSide(page: Page): number {
  const size = outputSize(cropQuad(page), IMPORT_MAX);
  return Math.max(64, Math.max(size.w, size.h));
}

/**
 * The corners the renderer actually uses.
 *
 * Detection and hand-placed corners sit a few pixels outside the paper, and an
 * inset keeps that sliver of desk off every page. A page made with "Keep the
 * whole photo" has no such sliver — it is the photo — so it gets the frames the
 * user saw, exactly.
 */
export function cropQuad(page: Pick<Page, "quad" | "whole">): Quad {
  return page.whole ? page.quad : insetQuad(page.quad, EDGE_INSET);
}

export const activePage = (): Page | null =>
  scan.pages.find((p) => p.id === scan.activeId) ?? null;

export function addPage(src: ImageData, name = "scan"): Page {
  const page: Page = {
    id: nextId++,
    name,
    src: markRaw(src),
    srcBlob: null,
    pending: null,
    rotation: 0,
    quad: fullFrameQuad(src.width, src.height),
    warped: null,
    warpedSide: 0,
    result: null,
    cacheKey: "",
    thumb: null,
    opts: defaultOpts(),
    whole: false,
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
  page.whole = false;
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
 * Warp (+ optionally enhance) a page.
 *
 * Two cached stages keep the editor feeling instant:
 *  - the warp is reused while the crop and the requested resolution are the
 *    same, so flipping Optimize costs one enhance pass, not a warp too;
 *  - Optimize off is literally the warp, so turning it off is free and the
 *    user really does get "the photo as taken", only straightened.
 */
export async function processPage(page: Page, opts: ProcessOptions = {}): Promise<void> {
  const { full = false, rewriteWarp = false, force = false } = opts;
  const maxSide = opts.maxSide ?? (full ? PREVIEW_MAX : 900);
  const key = `${maxSide}:${page.opts.optimize ? "opt" : "orig"}:${page.rotation}`;

  await ensureSource(page);

  if (!force && page.result && page.warped && page.warpedSide === maxSide && page.cacheKey === key) {
    if (full && !page.thumb) page.thumb = makeThumb(page.result);
    return;
  }

  await nextFrame();

  if (!page.warped || rewriteWarp || page.warpedSide !== maxSide) {
    const quad = cropQuad(page);
    const size = outputSize(quad, maxSide);
    page.warped = markRaw(warp(page.src, quad, size.w, size.h));
    page.warpedSide = maxSide;
  }

  const upright = rotateImageData(page.warped, page.rotation / 90);
  page.result = page.opts.optimize
    ? markRaw(enhance(upright, { mode: "bw", brightness: 0, contrast: 0, strength: 58 }))
    : upright;
  page.cacheKey = key;
  if (full) page.thumb = makeThumb(page.result);
}

/** Flip Optimize and re-render at the current preview resolution. */
export function toggleOptimize(page: Page): void {
  page.opts.optimize = !page.opts.optimize;
}

/** Turn the page a quarter turn clockwise. */
export function rotatePage(page: Page): void {
  page.rotation = (page.rotation + 90) % 360;
  // a quarter turn does not crop anything: "whole" survives it
  // The warp is unchanged, so only the look cache has to go.
  page.result = null;
  page.cacheKey = "";
}

/** Put a page back where it came from — the other half of a removal. */
export function insertPage(page: Page, index: number): void {
  const at = Math.max(0, Math.min(index, scan.pages.length));
  scan.pages.splice(at, 0, page);
  scan.activeId = page.id;
  // the removal deleted the stored copy: undo has to put it back
  scheduleSave(page);
  scheduleSave();
}

/** Restore a list of pages (undo of "clear all"). */
export function insertPages(pages: Page[]): void {
  scan.pages.unshift(...pages);
  scan.activeId = scan.pages[0]?.id ?? 0;
  for (const page of pages) scheduleSave(page);
  scheduleSave();
}

export function removePage(id: number): void {
  const index = scan.pages.findIndex((p) => p.id === id);
  if (index === -1) return;
  scan.pages.splice(index, 1);
  if (scan.activeId === id) {
    scan.activeId = scan.pages[Math.min(index, scan.pages.length - 1)]?.id ?? 0;
  }
  void projectStore()?.dropPage(id);
  scheduleSave();
}

export function clearPages(): void {
  scan.pages.splice(0, scan.pages.length);
  scan.activeId = 0;
  void projectStore()?.wipe();
}

/** Move a page to another slot — dragging one card in front of another. */
export function movePage(from: number, to: number): void {
  if (from === to) return;
  const target = Math.max(0, Math.min(scan.pages.length - 1, to));
  if (from < 0 || from >= scan.pages.length || target === from) return;
  const [page] = scan.pages.splice(from, 1);
  scan.pages.splice(target, 0, page);
  scheduleSave();
}

/* ------------------------------------------------------------- persistence */

/**
 * Decoding is the one part of restoring that costs real time, so it happens
 * when a page is actually opened rather than during launch. Everything that
 * needs pixels awaits this first.
 */
export async function ensureSource(page: Page): Promise<void> {
  if (!page.pending) return;
  const pending = page.pending;
  page.pending = null;
  try {
    page.src = markRaw(await pending);
  } catch {
    // An unreadable photo is not a crash: the page keeps its thumbnail and
    // simply cannot be re-cropped.
    page.pending = null;
  }
}

let saveTimer = 0;
let saving = false;
const dirty = new Set<number>();
let metaDirty = false;
/**
 * Pages whose photo could not be encoded yet, and when to try again.
 *
 * They stay dirty until they are actually on disk. Dropping them (as this used
 * to) meant one failed `toBlob` — a full disk, a private window, a phone under
 * memory pressure — and the page was never written again: it survived the
 * session and vanished on the next launch, with nothing to see in between.
 */
const retry = new Map<number, { at: number; tries: number }>();

/**
 * Write the project to the device, debounced. Called from the handful of places
 * that change something a reload should keep: a new page, a finished crop, a
 * different look, a rotation, a reorder.
 */
export function scheduleSave(page?: Page): void {
  const store = projectStore();
  if (!store) return;
  if (page) dirty.add(page.id);
  else metaDirty = true;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), 500);
}

function metaSnapshot(): StoredMeta {
  return {
    format: scan.format,
    filename: scan.filename,
    activeId: scan.activeId,
    ids: scan.pages.map((p) => p.id),
  };
}

async function encodeSource(page: Page): Promise<Blob | null> {
  if (page.srcBlob) return page.srcBlob;
  // A restored page keeps the blob it came from. Decoding first matters: writing
  // `src: null` over a good record would throw the photo away for good.
  if (page.pending) {
    await ensureSource(page);
    if (page.srcBlob) return page.srcBlob;
  }
  try {
    const canvas = imageDataToCanvas(page.src);
    if (typeof canvas.toBlob !== "function") return null;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/jpeg", 0.92)
    );
    page.srcBlob = blob;
    return blob;
  } catch {
    return null;
  }
}

/** Flush everything that is waiting; safe to call on pagehide. */
export async function flushSave(): Promise<void> {
  const store = projectStore();
  if (!store || saving) return;
  window.clearTimeout(saveTimer);
  saving = true;
  try {
    for (const id of [...dirty]) {
      const page = scan.pages.find((p) => p.id === id);
      dirty.delete(id);
      if (!page) continue;
      const src = await encodeSource(page);
      // No photo, no record: writing `src: null` would replace a good copy on
      // disk with a page that can never be opened or exported again. Keep it
      // dirty and try again a little later instead of forgetting it.
      if (!src) {
        const tries = (retry.get(id)?.tries ?? 0) + 1;
        retry.set(id, { at: Date.now() + Math.min(8000, 500 * 2 ** (tries - 1)), tries });
        dirty.add(id);
        continue;
      }
      retry.delete(id);
      const record: StoredPage = {
        id: page.id,
        name: page.name,
        quad: page.quad.map((p) => ({ ...p })) as Quad,
        rotation: page.rotation,
        whole: page.whole,
        optimize: page.opts.optimize,
        thumb: page.thumb,
        src,
      };
      await store.writePage(record);
    }
    if (metaDirty) {
      metaDirty = false;
      await store.writeMeta(metaSnapshot());
    }
  } catch {
    /* a full disk or a private window: the session still works */
  } finally {
    saving = false;
    // a change that arrived mid-write must not be the one that is lost — and a
    // page that could not be written is retried on a widening delay, not in a
    // tight loop
    if (dirty.size || metaDirty) {
      const now = Date.now();
      const waiting = [...retry.values()].map((r) => r.at - now).filter((ms) => ms > 0);
      const delay = Math.max(120, waiting.length ? Math.min(...waiting) : 120);
      window.setTimeout(() => void flushSave(), delay);
    }
  }
}

/**
 * Bring back the last project. Returns how many pages were restored; the caller
 * decides whether that deserves a word on screen.
 */
export async function restoreProject(): Promise<number> {
  const store = projectStore();
  if (!store) return 0;
  let records: StoredPage[] = [];
  let meta: StoredMeta | null = null;
  try {
    records = await store.readPages();
    meta = await store.readMeta();
  } catch {
    return 0;
  }
  // Records written before this rule existed can carry no photo at all. They
  // cannot be opened or exported, so restoring them would only be a broken tile.
  records = records.filter((record) => Boolean(record.src));
  if (!records.length) return 0;

  const order = meta?.ids ?? [];
  records.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia === -1 && ib === -1) return a.id - b.id;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  const restored: Page[] = records.map((record) => {
      // a decode that fails must not become an unhandled rejection: nothing awaits
    // it until the page is opened
    const pending = record.src
      ? decodeSource(record.src).catch((err) => {
          console.warn("[scano] could not decode a stored page", err);
          return new ImageData(1, 1);
        })
      : null;
    const page: Page = {
      id: record.id,
      name: record.name || "scan",
      // 1x1 until the decode lands; nothing draws it before then
      src: markRaw(new ImageData(1, 1)),
      srcBlob: record.src,
      pending,
      rotation: record.rotation ?? 0,
      whole: Boolean(record.whole),
      quad: record.quad,
      warped: null,
      warpedSide: 0,
      result: null,
      cacheKey: "",
      thumb: record.thumb,
      opts: { optimize: Boolean(record.optimize) },
    };
    return page;
  });

  // A shot taken in the half-second since launch must not be overwritten: the
  // stored pages are older, so they go in front.
  if (scan.pages.length) scan.pages.unshift(...restored);
  else scan.pages.splice(0, scan.pages.length, ...restored);
  if (meta) {
    scan.format = meta.format ?? "a4";
    scan.filename = meta.filename ?? "";
    scan.activeId = restored.some((p) => p.id === meta!.activeId) ? meta.activeId : restored[0].id;
  } else {
    scan.activeId = restored[0].id;
  }
  nextId = Math.max(nextId, ...restored.map((p) => p.id + 1));
  return restored.length;
}

async function decodeSource(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    return bitmapToImageData(bitmap, IMPORT_MAX);
  } finally {
    bitmap.close?.();
  }
}

export type { Mode, Quad };
