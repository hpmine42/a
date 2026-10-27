import { describe, expect, it, vi } from "vitest";
import { easeOutCubic, glideQuad, prefersReducedMotion, sleep } from "../src/lib/anim";

describe("animation helpers", () => {
  it("eases out, so motion starts fast and settles", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    // past the halfway point in time, well past halfway in distance
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.8);
  });

  it("jumps straight to the target when motion is not wanted", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    expect(prefersReducedMotion()).toBe(true);

    const frames: { x: number; y: number }[][] = [];
    await glideQuad(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }],
      200,
      (quad) => frames.push(quad)
    );
    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toEqual({ x: 5, y: 5 });
    vi.unstubAllGlobals();
  });

  it("sleeps for roughly the time it was asked to", async () => {
    const started = Date.now();
    await sleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
