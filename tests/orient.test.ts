import { describe, expect, it } from "vitest";
import { warp, type Quad } from "../src/lib/cv";
import { rotateImageData } from "../src/lib/image";
import { quarter, sourceQuad, toSource, toView, viewQuad, viewSize } from "../src/lib/orient";
import { installDomStubs } from "./setup";

installDomStubs();

/**
 * A photo whose four corners are four different colours, so "which corner ended
 * up where" can be read off the pixels instead of trusted.
 */
function corners(w: number, h: number): ImageData {
  const img = new ImageData(w, h);
  const paint = (x: number, y: number, r: number, g: number, b: number) => {
    const at = (y * w + x) * 4;
    img.data[at] = r;
    img.data[at + 1] = g;
    img.data[at + 2] = b;
    img.data[at + 3] = 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const left = x < w / 2;
      const top = y < h / 2;
      if (top && left) paint(x, y, 255, 0, 0);
      else if (top) paint(x, y, 0, 255, 0);
      else if (left) paint(x, y, 255, 255, 0);
      else paint(x, y, 0, 0, 255);
    }
  }
  return img;
}

function pixelAt(img: ImageData, x: number, y: number): number[] {
  const at = (y * img.width + x) * 4;
  return [...img.data.slice(at, at + 3)];
}

/** A visual comparison: bilinear sampling moves colours a little, not a lot. */
function near(a: number[], b: number[], tolerance = 40): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
}

describe("turning a page while cropping", () => {
  it("maps a point there and back for every quarter turn", () => {
    const w = 40;
    const h = 30;
    for (const q of [0, 1, 2, 3]) {
      for (const p of [
        { x: 0, y: 0 },
        { x: 40, y: 30 },
        { x: 7, y: 22 },
      ]) {
        const there = toView(p, q, w, h);
        const back = toSource(there, q, w, h);
        expect(back.x).toBeCloseTo(p.x, 6);
        expect(back.y).toBeCloseTo(p.y, 6);
      }
    }
  });

  it("swaps the sides on a quarter turn, and only then", () => {
    expect(viewSize(40, 30, 0)).toEqual({ w: 40, h: 30 });
    expect(viewSize(40, 30, 1)).toEqual({ w: 30, h: 40 });
    expect(viewSize(40, 30, 2)).toEqual({ w: 40, h: 30 });
    expect(viewSize(40, 30, 3)).toEqual({ w: 30, h: 40 });
  });

  it("counts quarter turns from degrees, negative ones included", () => {
    expect(quarter(0)).toBe(0);
    expect(quarter(90)).toBe(1);
    expect(quarter(180)).toBe(2);
    expect(quarter(270)).toBe(3);
    expect(quarter(360)).toBe(0);
    expect(quarter(-90)).toBe(3);
  });

  it("keeps index 0 on the corner a person calls top left", () => {
    const quad: Quad = [
      { x: 2, y: 3 },
      { x: 37, y: 1 },
      { x: 39, y: 28 },
      { x: 1, y: 29 },
    ];
    // a quarter turn clockwise: the photo's bottom-left becomes the new top-left
    const seen = viewQuad(quad, 1, 40, 30);
    expect(seen[0]).toEqual(toView(quad[3], 1, 40, 30));
    expect(seen[1]).toEqual(toView(quad[0], 1, 40, 30));
    // an upright photo is left alone
    expect(viewQuad(quad, 0, 40, 30)).toEqual(quad);
  });

  it("turns a view quad back into the photo it came from", () => {
    const quad: Quad = [
      { x: 2, y: 3 },
      { x: 37, y: 1 },
      { x: 39, y: 28 },
      { x: 1, y: 29 },
    ];
    for (const q of [0, 1, 2, 3]) {
      const round = sourceQuad(viewQuad(quad, q, 40, 30), q, 40, 30);
      round.forEach((p, i) => {
        expect(p.x).toBeCloseTo(quad[i].x, 6);
        expect(p.y).toBeCloseTo(quad[i].y, 6);
      });
    }
  });

  /**
   * The invariant the whole module exists for: cropping in the turned view has
   * to produce the page the view showed. "Turn the photo, warp it with the
   * corners I placed" and "warp the photo with the corners the module derived,
   * then turn the result" must be the same picture.
   */
  it("gives the same page as turning the photo and cropping there", () => {
    const w = 40;
    const h = 30;
    const src = corners(w, h);
    for (const q of [1, 2, 3]) {
      const size = viewSize(w, h, q);
      // the same frame, seen in the turned view
      const seen: Quad = [
        { x: 3, y: 2 },
        { x: size.w - 3, y: 2 },
        { x: size.w - 3, y: size.h - 2 },
        { x: 3, y: size.h - 2 },
      ];
      // what gets stored and rendered: source pixels + derived corners, then turned
      const stored = sourceQuad(seen, q, w, h);
      const result = rotateImageData(warp(src, stored, 20, 15), q);
      // what the user saw while dragging: the turned photo, cropped where they
      // put the handles, at the size of the page that came out
      const view = warp(rotateImageData(src, q), seen, result.width, result.height);

      for (const [x, y] of [
        [2, 2],
        [17, 2],
        [17, 12],
        [2, 12],
      ]) {
        expect(near(pixelAt(result, x, y), pixelAt(view, x, y)), `${q}: (${x},${y})`).toBe(true);
      }
    }
  });
});
