import { inflateSync } from "node:zlib";
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
    ocr: null,
    textLayer: true,
  } as Page;
}

/** jsdom's Blob has no arrayBuffer(); the tests read the PDF through FileReader. */
async function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Everything a PDF *draws* lives in Flate-compressed streams, so asserting on
 * the raw file would only ever see the object headers. This inflates them, and
 * returns the page content that a reader would actually render.
 */
async function pageContent(blob: Blob): Promise<string> {
  const bytes = await readBytes(blob);
  const raw = new TextDecoder("latin1").decode(bytes);
  let out = "";
  let from = 0;
  for (;;) {
    const start = raw.indexOf("stream", from);
    if (start === -1) break;
    const end = raw.indexOf("endstream", start);
    if (end === -1) break;
    from = end + 9;
    // the stream body starts after the EOL that follows the keyword
    let body = start + 6;
    if (raw[body] === "\r") body++;
    if (raw[body] === "\n") body++;
    const chunk = bytes.subarray(body, end);
    try {
      out += new TextDecoder("latin1").decode(inflateSync(chunk));
    } catch {
      // not compressed (or not a content stream): read it as it is
      out += new TextDecoder("latin1").decode(chunk);
    }
  }
  return out;
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

  it("writes the recognised words into the file as invisible text", async () => {
    const page = makePage();
    page.ocr = {
      text: "TOTAL DUE 1,620.00",
      confidence: 88,
      width: 1200,
      height: 1600,
      at: 0,
      words: [
        { text: "TOTAL", confidence: 92, box: [0.1, 0.2, 0.3, 0.23] },
        { text: "1,620.00", confidence: 80, box: [0.6, 0.2, 0.85, 0.23] },
      ],
    };
    const built = await buildPdf([page], "a4", undefined, "Rechnung");
    const text = await pageContent(built.blob);
    // the words are in the file, drawn in render mode 3 (invisible)
    expect(text).toContain("(TOTAL) Tj");
    expect(text).toContain("(1,620.00) Tj");
    expect(text).toContain("3 Tr");
  });

  it("leaves a page without recognised text exactly as it was", async () => {
    const plain = await buildPdf([makePage()], "a4", undefined, "X");
    expect(await pageContent(plain.blob)).not.toContain("3 Tr");

    // and switching the layer off on a page that *has* words does the same
    const page = makePage();
    page.textLayer = false;
    page.ocr = {
      text: "TOTAL",
      confidence: 90,
      width: 1200,
      height: 1600,
      at: 0,
      words: [{ text: "TOTAL", confidence: 92, box: [0.1, 0.2, 0.3, 0.23] }],
    };
    const built = await buildPdf([page], "a4", undefined, "X");
    expect(await pageContent(built.blob)).not.toContain("(TOTAL) Tj");
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
