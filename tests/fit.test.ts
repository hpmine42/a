import { afterEach, describe, expect, it } from "vitest";
import { applyViewportFit, forcedBoost, viewportBoost } from "../src/lib/fit";

describe("viewportBoost", () => {
  it("leaves a normal phone viewport alone", () => {
    expect(viewportBoost(411, 411)).toBe(1);
    expect(viewportBoost(390, 393)).toBe(1);
  });

  it("scales up a phone that reports a desktop-sized viewport", () => {
    // Chrome "Desktop site": 980px layout on a 411px screen.
    expect(viewportBoost(980, 411)).toBe(2.38);
    expect(viewportBoost(980, 390)).toBe(2.51);
  });

  it("ignores tablets and desktop windows, where nothing is squeezed", () => {
    expect(viewportBoost(1024, 1024)).toBe(1);
    expect(viewportBoost(1440, 1440)).toBe(1);
    expect(viewportBoost(980, 820)).toBe(1);
  });

  it("never inflates beyond 3x, and survives nonsense input", () => {
    expect(viewportBoost(3000, 400)).toBe(3);
    expect(viewportBoost(0, 411)).toBe(1);
    expect(viewportBoost(Number.NaN, 411)).toBe(1);
    expect(viewportBoost(980, 0)).toBe(1);
  });
});

describe("forcedBoost", () => {
  it("accepts a sane override and ignores the rest", () => {
    expect(forcedBoost("?u=2.4")).toBe(2.4);
    expect(forcedBoost("?u=1")).toBe(1);
    expect(forcedBoost("?u=9")).toBe(1);
    expect(forcedBoost("?u=abc")).toBe(1);
    expect(forcedBoost("")).toBe(1);
  });
});

describe("applyViewportFit", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--u");
    delete document.documentElement.dataset.fit;
  });

  it("writes the multiplier to the root element", () => {
    Object.defineProperty(window.screen, "width", { value: 411, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 980, configurable: true });
    expect(applyViewportFit()).toBeCloseTo(2.38, 2);
    expect(document.documentElement.style.getPropertyValue("--u")).toBe("2.38");
    expect(document.documentElement.dataset.fit).toBe("boost");
  });

  it("clears the fix once the viewport matches the screen", () => {
    Object.defineProperty(window.screen, "width", { value: 411, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 411, configurable: true });
    expect(applyViewportFit()).toBe(1);
    expect(document.documentElement.style.getPropertyValue("--u")).toBe("");
    expect(document.documentElement.dataset.fit).toBeUndefined();
  });
});
