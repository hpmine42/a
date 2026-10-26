import { describe, expect, it } from "vitest";
import { clampToBox, containFit, loupeSourceRect, toCanvasPoint, toImagePoint } from "../src/lib/geometry";

// a letterboxed portrait image inside a wide box: dx/dy are non-zero, which is
// exactly the case where a loupe drifts away from the handle
const FIT = containFit(1000, 1400, 400, 400);

describe("containFit", () => {
  it("centres the image and keeps its aspect ratio", () => {
    expect(FIT.scale).toBeCloseTo(400 / 1400, 6);
    expect(FIT.dx).toBeCloseTo((400 - 1000 * FIT.scale) / 2, 6);
    expect(FIT.dy).toBeCloseTo(0, 6);
    expect(FIT.dx).toBeGreaterThan(0);
  });
});

describe("coordinate round trip", () => {
  it("maps CSS ↔ image both ways", () => {
    const image = { x: 500, y: 700 };
    const css = toCanvasPoint(image, FIT);
    const back = toImagePoint(css, FIT);
    expect(back.x).toBeCloseTo(image.x, 6);
    expect(back.y).toBeCloseTo(image.y, 6);
  });

  it("accounts for the letterbox offset", () => {
    // the top-left of the drawn image is at (dx, dy), not (0, 0)
    expect(toImagePoint({ x: FIT.dx, y: FIT.dy }, FIT)).toEqual({ x: 0, y: 0 });
  });
});

describe("loupeSourceRect", () => {
  const R = 58;
  const ZOOM = 2.6;

  it("is centred on the handle", () => {
    const handle = toCanvasPoint({ x: 640, y: 900 }, FIT);
    const rect = loupeSourceRect(handle, FIT, R, ZOOM);
    expect(rect.sx + rect.size / 2).toBeCloseTo(640, 4);
    expect(rect.sy + rect.size / 2).toBeCloseTo(900, 4);
  });

  it("magnifies by the requested factor relative to the screen", () => {
    const handle = toCanvasPoint({ x: 500, y: 700 }, FIT);
    const rect = loupeSourceRect(handle, FIT, R, ZOOM);
    // one image pixel must appear zoom × the on-screen pixel size
    const screenPxPerImagePx = (R * 2) / rect.size;
    expect(screenPxPerImagePx).toBeCloseTo(ZOOM * FIT.scale, 6);
  });

  it("stays centred for every corner of the sheet", () => {
    for (const image of [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1400 },
      { x: 0, y: 1400 },
    ]) {
      const rect = loupeSourceRect(toCanvasPoint(image, FIT), FIT, R, ZOOM);
      expect(rect.sx + rect.size / 2).toBeCloseTo(image.x, 4);
      expect(rect.sy + rect.size / 2).toBeCloseTo(image.y, 4);
    }
  });
});

describe("clampToBox", () => {
  it("keeps a floating element inside the stage", () => {
    const p = clampToBox({ x: 5, y: 395 }, 58, 400, 400);
    expect(p.x).toBeGreaterThanOrEqual(66);
    expect(p.y).toBeLessThanOrEqual(400 - 66);
  });
});
