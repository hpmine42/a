import { describe, expect, it } from "vitest";
import {
  clampToBox,
  containFit,
  loupeSourceRect,
  reticle,
  toCanvasPoint,
  toImagePoint,
} from "../src/lib/geometry";

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

/**
 * The crosshair in the magnifier.
 *
 * It was there in code and invisible on screen: drawn through the transform that
 * magnifies the photo, so its screen coordinates were read as source pixels and
 * it landed outside the circle, clipped away. These tests pin the shape in the
 * space it is actually drawn in — screen coordinates inside the loupe.
 */
describe("reticle", () => {
  const R = 58;

  it("has four arms, and they meet the centre symmetrically", () => {
    const { lines } = reticle(200, 300, R);
    expect(lines.length).toBe(4);
    // two horizontal, two vertical
    expect(lines.filter((l) => l.y1 === l.y2).length).toBe(2);
    expect(lines.filter((l) => l.x1 === l.x2).length).toBe(2);
    // centred on the point that is being looked at
    const xs = lines.flatMap((l) => [l.x1, l.x2]);
    const ys = lines.flatMap((l) => [l.y1, l.y2]);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(400, 6);
    expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(600, 6);
  });

  it("stays inside the circle, so nothing gets clipped", () => {
    for (const [cx, cy] of [
      [60, 60],
      [200, 300],
      [340, 520],
    ]) {
      const { lines, ring } = reticle(cx, cy, R);
      for (const line of lines) {
        const inner = Math.hypot(line.x1 - cx, line.y1 - cy);
        const outer = Math.hypot(line.x2 - cx, line.y2 - cy);
        expect(outer).toBeLessThan(R - 4);
        expect(inner).toBeGreaterThan(ring + 1);
      }
    }
  });

  it("leaves the pixel itself visible in the gap", () => {
    const { lines, ring } = reticle(100, 100, R);
    // no segment passes through the centre point
    for (const line of lines) {
      const crosses =
        Math.min(line.x1, line.x2) <= 100 &&
        100 <= Math.max(line.x1, line.x2) &&
        Math.min(line.y1, line.y2) <= 100 &&
        100 <= Math.max(line.y1, line.y2);
      expect(crosses).toBe(false);
    }
    // and the ring around it is small enough not to hide it
    expect(ring).toBeGreaterThan(1.5);
    expect(ring).toBeLessThan(7);
  });

  it("scales with the loupe instead of being a fixed tiny mark", () => {
    const small = reticle(0, 0, 40);
    const large = reticle(0, 0, 90);
    const reach = (r: ReturnType<typeof reticle>) => Math.max(...r.lines.map((l) => Math.abs(l.x2)));
    expect(reach(large)).toBeGreaterThan(reach(small));
  });
});
