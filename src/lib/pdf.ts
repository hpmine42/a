import type { jsPDF as JsPdf } from "jspdf";
import { enhance, insetQuad, outputSize, warp } from "./cv";
import { imageDataToCanvas, nextFrame, slug } from "./image";
import { EDGE_INSET, EXPORT_MAX, naturalSide, type Page } from "./store";

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

/** Build the PDF and return the file name it was saved as. */
export async function exportPdf(
  pages: Page[],
  format: PageFormat = "a4",
  onProgress?: Progress,
  /** Base name for the file, without `.pdf`. */
  name = ""
): Promise<string> {
  // jsPDF and its dependencies are ~370 kB that nobody needs until the moment a
  // PDF is saved, so the whole library is loaded on demand.
  const { jsPDF } = await import("jspdf");
  let doc: JsPdf | null = null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    onProgress?.(i, pages.length);
    await nextFrame();

    const quad = insetQuad(page.quad, EDGE_INSET);
    // never scale a page above what the photo has: invented pixels cost file
    // size and buy nothing a reader can see
    const size = outputSize(quad, Math.min(EXPORT_MAX, naturalSide(page)));
    const warped = warp(page.src, quad, size.w, size.h);
    // Optimize off means untouched: the straight photo, nothing applied
    const result = page.opts.optimize
      ? enhance(warped, { mode: "bw", brightness: 0, contrast: 0, strength: 58 })
      : warped;
    // An optimised page is black text on paper: it survives 0.9 untouched and
    // saves a third of the file. A photo keeps 0.95 — that is where it shows.
    const quality = page.opts.optimize ? 0.9 : 0.95;
    const dataUrl = imageDataToCanvas(result).toDataURL("image/jpeg", quality);

    const paper =
      format === "fit"
        ? { width: (result.width * 25.4) / 200, height: (result.height * 25.4) / 200 }
        : PAPER[format];
    const place = fitOnPage(result.width, result.height, paper);

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

    doc.addImage(dataUrl, "JPEG", place.x, place.y, place.width, place.height, undefined, "SLOW");
  }

  onProgress?.(pages.length, pages.length);
  const filename =
    name.trim() || (pages.length === 1 ? slug(pages[0].name) : "");
  const safe = pdfFilename(filename, pages.length);
  doc?.save(safe);
  return safe;
}
