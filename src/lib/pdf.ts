import { jsPDF } from "jspdf";
import { enhance, outputSize, warp } from "./cv";
import { imageDataToCanvas, nextFrame, slug } from "./image";
import { EXPORT_MAX, type Page } from "./store";

export type ExportProgress = (done: number, total: number) => void;

/**
 * Build a multi-page A4 PDF from the scan pages. Each page is re-rendered at
 * export resolution from the original photo, so the PDF is sharper than the
 * editor preview.
 */
export async function exportPdf(pages: Page[], onProgress?: ExportProgress): Promise<string> {
  let doc: jsPDF | null = null;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    onProgress?.(i, pages.length);
    await nextFrame();

    const size = outputSize(page.quad, EXPORT_MAX);
    const warped = warp(page.src, page.quad, size.w, size.h);
    const result = enhance(warped, page.opts);
    const dataUrl = imageDataToCanvas(result).toDataURL("image/jpeg", 0.9);

    const landscape = result.width > result.height;
    const orientation = landscape ? "landscape" : "portrait";
    if (!doc) {
      doc = new jsPDF({ unit: "mm", format: "a4", orientation, compress: true });
    } else {
      doc.addPage("a4", orientation);
    }

    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const ratio = result.width / result.height;
    let w = pw;
    let h = pw / ratio;
    if (h > ph) {
      h = ph;
      w = ph * ratio;
    }
    doc.addImage(dataUrl, "JPEG", (pw - w) / 2, (ph - h) / 2, w, h, undefined, "FAST");
  }

  onProgress?.(pages.length, pages.length);
  const filename =
    pages.length === 1 ? `${slug(pages[0].name)}.pdf` : `scan-${pages.length}-pages.pdf`;
  doc?.save(filename);
  return filename;
}
