import { describe, expect, it } from "vitest";
import { fitOnPage, pdfFilename, textLayerRuns } from "../src/lib/pdf";
import type { OcrPage } from "../src/lib/ocr";

const A4 = { width: 210, height: 297 };
const LETTER = { width: 215.9, height: 279.4 };

describe("fitOnPage", () => {
  it("keeps a portrait scan portrait and inside the margins", () => {
    const place = fitOnPage(1200, 1600, A4);
    expect(place.orientation).toBe("portrait");
    expect(place.size).toEqual(A4);
    expect(place.width).toBeLessThan(A4.width);
    expect(place.height).toBeLessThan(A4.height);
    expect(place.x).toBeGreaterThan(0);
    expect(place.y).toBeGreaterThan(0);
    // centred
    expect(place.x * 2 + place.width).toBeCloseTo(A4.width, 6);
    expect(place.y * 2 + place.height).toBeCloseTo(A4.height, 6);
  });

  it("swaps the sheet for a landscape scan but fills the same area", () => {
    const place = fitOnPage(1600, 1200, A4);
    expect(place.orientation).toBe("landscape");
    expect(place.size).toEqual({ width: A4.height, height: A4.width });
    // the long side of the image maps to the long side of the sheet
    expect(place.width).toBeGreaterThan(place.height);
  });

  it("preserves the image aspect ratio within a rounding error", () => {
    for (const [w, h] of [
      [1200, 1600],
      [1600, 1200],
      [1000, 1000],
      [900, 2400],
    ]) {
      const place = fitOnPage(w, h, LETTER);
      expect(place.width / place.height).toBeCloseTo(w / h, 2);
    }
  });

  it("never overflows the sheet", () => {
    for (const paper of [A4, LETTER]) {
      for (const [w, h] of [
        [1200, 1600],
        [2400, 300],
        [300, 2400],
      ]) {
        const place = fitOnPage(w, h, paper);
        expect(place.x).toBeGreaterThanOrEqual(0);
        expect(place.y).toBeGreaterThanOrEqual(0);
        expect(place.x + place.width).toBeLessThanOrEqual(place.size.width + 1e-9);
        expect(place.y + place.height).toBeLessThanOrEqual(place.size.height + 1e-9);
      }
    }
  });
});

describe("pdfFilename", () => {
  it("keeps a normal name and appends the extension", () => {
    expect(pdfFilename("Invoice August", 1)).toBe("Invoice August.pdf");
  });

  it("does not double up an extension the user typed", () => {
    expect(pdfFilename("invoice.pdf", 1)).toBe("invoice.pdf");
    expect(pdfFilename("invoice.PDF", 1)).toBe("invoice.pdf");
  });

  it("strips path separators and characters filesystems reject", () => {
    expect(pdfFilename("2026/03 Rechnung: Müller?", 2)).toBe("2026-03 Rechnung- Müller.pdf");
  });

  it("falls back to a sane name when the field is empty", () => {
    expect(pdfFilename("   ", 1)).toBe("Scano scan.pdf");
    expect(pdfFilename("", 3)).toBe("Scano scan 3 pages.pdf");
  });

  it("caps the length so a paste cannot produce an unopenable file", () => {
    expect(pdfFilename("x".repeat(300), 1).length).toBeLessThanOrEqual(84);
  });
});


/**
 * The invisible text layer.
 *
 * Placement is the whole feature: if a word lands somewhere else than the ink it
 * describes, selecting a sentence in a PDF reader highlights the wrong thing, and
 * a search finds a word that is nowhere near where it says it is.
 */
describe("textLayerRuns", () => {
  /** A word box in fractions of the page, like the recogniser reports it. */
  const page = (words: OcrPage["words"]): OcrPage => ({
    text: "",
    words,
    confidence: 80,
    width: 1800,
    height: 2400,
    at: 0,
  });
  const place = { x: 20, y: 20, width: 100, height: 140 };
  /** Pretend Helvetica draws every character at half its size. */
  const measure = (text: string, sizePt: number) => text.length * sizePt * 0.5;

  it("puts a word where the word is", () => {
    const [run] = textLayerRuns(
      page([{ text: "TOTAL", confidence: 90, box: [0.1, 0.5, 0.3, 0.52] }]),
      place,
      measure
    );
    // 10% into a 100mm wide placement
    expect(run.x).toBeCloseTo(20 + 10, 5);
    // the baseline sits inside the box, a little below its middle
    expect(run.y).toBeGreaterThan(20 + 0.5 * 140);
    expect(run.y).toBeLessThan(20 + 0.52 * 140);
  });

  it("sizes the text to the ink, and stretches it to the box", () => {
    const box: [number, number, number, number] = [0, 0, 0.2, 0.02];
    const [run] = textLayerRuns(page([{ text: "ACME", confidence: 90, box }]), place, measure);
    // 2% of a 140mm tall placement ≈ 2.8mm of ink; a word box is ~0.78 of the
    // font size, so that is ≈10pt — a header, not body text and not a poster
    expect(run.size).toBeGreaterThan(8);
    expect(run.size).toBeLessThan(12);
    // the box is 20mm wide; Helvetica-at-half-size needs 4 × size × 0.5 mm
    const natural = measure("ACME", run.size);
    expect(run.scale).toBeCloseTo(20 / natural, 1);
  });

  it("does not turn one merged box into a giant word", () => {
    // Recognisers occasionally report a box that spans two lines. Sized naively
    // that becomes 3x type; it is clamped to the page's own type scale instead.
    const runs = textLayerRuns(
      page([
        { text: "line", confidence: 90, box: [0.1, 0.1, 0.3, 0.115] },
        { text: "line", confidence: 90, box: [0.1, 0.2, 0.3, 0.215] },
        { text: "line", confidence: 90, box: [0.1, 0.3, 0.3, 0.315] },
        { text: "merged", confidence: 40, box: [0.1, 0.4, 0.4, 0.46] },
      ]),
      place,
      measure
    );
    const normal = runs[0].size;
    const merged = runs[runs.length - 1].size;
    expect(merged).toBeGreaterThan(normal);
    expect(merged).toBeLessThan(normal * 2);
  });

  it("skips words with nothing in them and boxes with no area", () => {
    const runs = textLayerRuns(
      page([
        { text: "   ", confidence: 90, box: [0, 0, 0.1, 0.1] },
        { text: "zero", confidence: 90, box: [0.4, 0.4, 0.4, 0.44] },
        { text: "real", confidence: 90, box: [0.2, 0.2, 0.3, 0.22] },
      ]),
      place,
      measure
    );
    expect(runs.map((r) => r.text)).toEqual(["real"]);
  });
});
