import { describe, expect, it } from "vitest";
import { fitOnPage, pdfFilename } from "../src/lib/pdf";

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
    expect(pdfFilename("   ", 1)).toBe("scan.pdf");
    expect(pdfFilename("", 3)).toBe("scan-3-pages.pdf");
  });

  it("caps the length so a paste cannot produce an unopenable file", () => {
    expect(pdfFilename("x".repeat(300), 1).length).toBeLessThanOrEqual(84);
  });
});
