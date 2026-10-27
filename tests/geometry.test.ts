import { describe, expect, it } from "vitest";
import {
  centreMark,
  clampToBox,
  containFit,
  coverPoint,
  loupeSourceRect,
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
describe("centreMark", () => {
  const R = 58;

  it("marks the pixel and nothing else", () => {
    // no arms: four lines reaching out of the centre cut through the words you
    // are trying to line a corner up with, and pull the eye off the centre
    const mark = centreMark(R);
    expect(typeof mark).toBe("number");
    expect(mark).toBeGreaterThan(3);
    // a ring, not a target: it has to stay well inside the loupe
    expect(mark).toBeLessThan(R / 4);
  });

  it("is big enough to see and small enough to leave the pixel visible", () => {
    const mark = centreMark(R);
    // ~10px across on a 58px radius loupe: visible at arm's length, and the hole
    // in the middle still shows the pixel underneath
    expect(mark).toBeGreaterThanOrEqual(4);
    expect(mark).toBeLessThanOrEqual(6.5);
  });

  it("follows a bigger loupe, within limits", () => {
    expect(centreMark(90)).toBeGreaterThan(centreMark(40));
    expect(centreMark(400)).toBeLessThanOrEqual(7);
    expect(centreMark(4)).toBeGreaterThanOrEqual(3.5);
  });

  it("survives a nonsense radius instead of producing NaN", () => {
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const mark = centreMark(bad);
      expect(Number.isFinite(mark)).toBe(true);
      expect(mark).toBeGreaterThan(0);
    }
  });
});

describe("coverPoint", () => {
  // a landscape 1280x960 frame filling a tall 390x620 stage with object-fit: cover
  const MAP = (() => {
    const scale = Math.max(390 / 1280, 620 / 960);
    return { scale, dx: (390 - 1280 * scale) / 2, dy: (620 - 960 * scale) / 2, w: 390, h: 620 };
  })();
  const FRAME = { w: 1280, h: 960 };

  it("puts the middle of the stage in the middle of the frame", () => {
    const p = coverPoint({ x: 195, y: 310 }, MAP, FRAME);
    expect(p.x).toBeCloseTo(0.5, 6);
    expect(p.y).toBeCloseTo(0.5, 6);
  });

  it("maps a tap without the preview zoom the way it always did", () => {
    // the frame is wider than the stage, so the drawn image starts off to the left
    const p = coverPoint({ x: 0, y: 310 }, MAP, FRAME);
    expect(p.x).toBeCloseTo((0 - MAP.dx) / (1280 * MAP.scale), 6);
    expect(p.y).toBeCloseTo(0.5, 6);
  });

  it("follows the picture when the preview itself is scaled up", () => {
    // a lens with no hardware zoom: the preview layer is CSS-scaled 2x, so the
    // stage edge shows a point further out in the frame, not the same one
    const plain = coverPoint({ x: 0, y: 310 }, MAP, FRAME, 1);
    const zoomed = coverPoint({ x: 0, y: 310 }, MAP, FRAME, 2);
    expect(zoomed.x).toBeGreaterThan(plain.x);
    // the visible strip is the middle half of the frame, so the stage's left edge
    // lands a quarter of the way in from where it does unzoomed
    const layer = 1280 * MAP.scale;
    expect(zoomed.x).toBeCloseTo((195 - 195 / 2 - MAP.dx) / layer, 6);
    // and the centre still means the centre
    const centre = coverPoint({ x: 195, y: 310 }, MAP, FRAME, 2);
    expect(centre.x).toBeCloseTo(0.5, 6);
  });

  it("keeps the zoomed span inside the frame, whatever the factor", () => {
    for (const zoom of [1, 1.7, 3, 8]) {
      for (const x of [-200, 0, 195, 390, 900]) {
        const p = coverPoint({ x, y: 310 }, MAP, FRAME, zoom);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
      }
    }
  });

  it("survives a nonsense factor instead of producing NaN", () => {
    const p = coverPoint({ x: 195, y: 310 }, MAP, FRAME, 0);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(p.x).toBeCloseTo(0.5, 6);
  });
});
