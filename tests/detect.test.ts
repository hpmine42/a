import { describe, expect, it } from "vitest";
import { detectPageQuad, detectPageQuads, type Quad } from "../src/lib/cv";
import { quadError, renderScene, rotatedRect } from "./scene";
import { installDomStubs } from "./setup";

installDomStubs();

const asQuad = (q: Quad) => q as unknown as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];

describe("two sheets in one photo", () => {
  const left = rotatedRect(240, 350, 300, 420, -4);
  const right = rotatedRect(660, 350, 300, 420, 6);

  it("finds both pages instead of only the better one", () => {
    const scene = renderScene({ corners: left, extra: [right], paper: 230, desk: 88, deskWarmth: 30 });
    const quads = detectPageQuads(scene);
    expect(quads.length).toBe(2);
    // whichever order they come in, both sheets are there
    const errors = quads.map((q) => Math.min(quadError(left, asQuad(q)), quadError(right, asQuad(q))));
    expect(Math.max(...errors)).toBeLessThan(40);
  });

  it("does not invent a second page out of one sheet", () => {
    const single = renderScene({ corners: rotatedRect(450, 350, 330, 440, -5), paper: 228, desk: 84 });
    expect(detectPageQuads(single).length).toBe(1);
  });
});

describe("page detection on synthetic scenes", () => {
  it("finds a portrait sheet on a dark desk", () => {
    const corners = rotatedRect(450, 350, 320, 440, -7);
    const scene = renderScene({ corners, paper: 228, desk: 70 });
    const quad = detectPageQuad(scene);
    expect(quad).not.toBeNull();
    expect(quadError(corners, asQuad(quad!))).toBeLessThan(18);
  });

  it("finds a landscape sheet photographed slightly sideways", () => {
    const corners = rotatedRect(440, 330, 520, 340, 11);
    const scene = renderScene({ corners, paper: 214, desk: 120, deskWarmth: 28 });
    const quad = detectPageQuad(scene);
    expect(quad).not.toBeNull();
    expect(quadError(corners, asQuad(quad!))).toBeLessThan(22);
  });

  it("separates a warm wooden desk from neutral paper", () => {
    const corners = rotatedRect(430, 360, 300, 430, 4);
    const scene = renderScene({ corners, paper: 220, desk: 190, deskWarmth: 46 });
    const quad = detectPageQuad(scene);
    expect(quad).not.toBeNull();
    expect(quadError(corners, asQuad(quad!))).toBeLessThan(24);
  });

  it("falls back to edges when paper and desk are both white", () => {
    const corners = rotatedRect(450, 350, 330, 440, -3);
    // very low contrast: the colour mask cannot separate these
    const scene = renderScene({ corners, paper: 236, desk: 214, deskWarmth: 6, shading: 4 });
    const quad = detectPageQuad(scene);
    expect(quad).not.toBeNull();
    expect(quadError(corners, asQuad(quad!))).toBeLessThan(40);
  });

  it("returns nothing on an empty desk", () => {
    const scene = renderScene({
      corners: rotatedRect(-400, -400, 10, 10, 0),
      paper: 120,
      desk: 120,
      deskWarmth: 30,
    });
    expect(detectPageQuad(scene)).toBeNull();
  });

  it("returns nothing when the desk is uniform and bright", () => {
    const scene = renderScene({
      corners: rotatedRect(-600, -600, 10, 10, 0),
      paper: 200,
      desk: 200,
      deskWarmth: 2,
      shading: 0,
    });
    expect(detectPageQuad(scene)).toBeNull();
  });

  it("is stable when the same scene is scaled down", () => {
    const corners = rotatedRect(225, 175, 160, 220, -7);
    const scene = renderScene({ width: 450, height: 350, corners, paper: 228, desk: 70 });
    const quad = detectPageQuad(scene);
    expect(quad).not.toBeNull();
    expect(quadError(corners, asQuad(quad!))).toBeLessThan(18);
  });

  it("runs the live mode fast enough for a viewfinder", () => {
    const corners = rotatedRect(450, 350, 330, 440, -6);
    const scene = renderScene({ corners, paper: 226, desk: 80 });
    const started = performance.now();
    const quad = detectPageQuad(scene, { effort: "fast" });
    const ms = performance.now() - started;
    expect(quad).not.toBeNull();
    expect(ms).toBeLessThan(260);
  });
});
