import { beforeEach, describe, expect, it } from "vitest";
import { fakeCanvas, installDomStubs } from "./setup";
import {
  buildPdf,
  ExportError,
  isUsableImageUrl,
  pageBudgetScale,
  preloadPdf,
  safeCanvasSize,
} from "../src/lib/pdf";
import type { Page } from "../src/lib/store";

installDomStubs();

function makePage(w = 300, h = 400): Page {
  return {
    id: 1,
    name: "scan",
    src: new ImageData(w, h),
    srcBlob: null,
    pending: null,
    rotation: 0,
    quad: [
      { x: 0, y: 0 },
      { x: w - 1, y: 0 },
      { x: w - 1, y: h - 1 },
      { x: 0, y: h - 1 },
    ],
    warped: null,
    warpedSide: 0,
    result: null,
    cacheKey: "",
    thumb: null,
    opts: { optimize: false },
  } as Page;
}

beforeEach(() => fakeCanvas.reset());

describe("building the PDF", () => {
  it("produces a named file with a page for every page", async () => {
    const built = await buildPdf([makePage(), makePage()], "a4", undefined, "Steuer");
    expect(built.filename).toBe("Steuer.pdf");
    expect(built.blob.size).toBeGreaterThan(0);
    expect(built.blob.type).toBe("application/pdf");
  });

  it("renders smaller instead of giving up when a canvas comes back empty", async () => {
    // the first attempt is blank, as a browser past its canvas limit behaves
    fakeCanvas.blankCalls = 1;
    const built = await buildPdf([makePage()], "a4", undefined, "X");
    expect(built.blob.size).toBeGreaterThan(0);
    // the failed attempt plus one that worked
    expect(fakeCanvas.calls).toBe(2);
  });

  it("fails with a reason when no size produces an image", async () => {
    fakeCanvas.blank = true;
    await expect(buildPdf([makePage()], "a4")).rejects.toBeInstanceOf(ExportError);
    await expect(buildPdf([makePage()], "a4")).rejects.toMatchObject({ reason: "render" });
  });

  it("refuses a page that has no pixels rather than printing black paper", async () => {
    const page = makePage();
    // what a restored-but-undecoded page looks like
    page.src = new ImageData(1, 1);
    await expect(buildPdf([page], "a4")).rejects.toMatchObject({ reason: "render" });
  });

  it("knows what a failed canvas returns", () => {
    expect(isUsableImageUrl("data:,")).toBe(false);
    expect(isUsableImageUrl("")).toBe(false);
    expect(isUsableImageUrl("data:image/jpeg;base64,AAAA")).toBe(false);
    expect(isUsableImageUrl(fakeCanvas.url)).toBe(true);
  });
});

describe("the pixel budget", () => {
  it("gives a short document everything and a long one less, never nothing", () => {
    expect(pageBudgetScale(1)).toBe(1);
    expect(pageBudgetScale(4)).toBe(1);
    expect(pageBudgetScale(9)).toBeLessThan(1);
    expect(pageBudgetScale(30)).toBeGreaterThan(0.5);
  });
});

describe("the engine chunk", () => {
  it("is fetched once, so a second export is instant", async () => {
    const a = preloadPdf();
    const b = preloadPdf();
    expect(a).toBe(b);
    await a;
  });

  it("keeps a useful size cap for what a browser will draw", () => {
    expect(safeCanvasSize(2400, 3200)).toEqual({ w: 2400, h: 3200 });
    const size = safeCanvasSize(9000, 12000);
    expect(size.w * size.h).toBeLessThanOrEqual(8_000_000);
  });
});
