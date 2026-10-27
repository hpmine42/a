import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appHeightFor,
  applyBoost,
  applyViewportFit,
  boostFor,
  forcedBoost,
  viewportBoost,
  watchViewportFit,
} from "../src/lib/fit";

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

describe("boostFor", () => {
  it("undoes a browser that really paints the page small", () => {
    // desktop-site mode: the visual viewport says "scale 0.42"
    expect(
      boostFor({ layout: 980, screen: 411, visible: { width: 980, height: 800, scale: 0.42 } })
    ).toBe(2.38);
  });

  it("ignores a stale layout width from the first frames of a launch", () => {
    // A PWA cold start reports 980 for a moment while the screen is 411 — but
    // the visual viewport is the phone's own width, so nothing is squeezed.
    // Trusting this sample used to leave the whole UI 2.4× too big for the rest
    // of the session, because no resize follows to correct it.
    expect(
      boostFor({ layout: 980, screen: 411, visible: { width: 411, height: 890, scale: 1 } })
    ).toBe(1);
  });

  it("accepts the width ratio when the visible area agrees", () => {
    expect(
      boostFor({ layout: 980, screen: 411, visible: { width: 980, height: 800, scale: 1 } })
    ).toBe(2.38);
  });

  it("falls back to the width ratio on browsers without a visual viewport", () => {
    expect(boostFor({ layout: 980, screen: 411, visible: null })).toBe(2.38);
    expect(boostFor({ layout: 411, screen: 411, visible: null })).toBe(1);
  });

  it("always honours an explicit override", () => {
    expect(boostFor({ layout: 411, screen: 411, visible: null, forced: 2.4 })).toBe(2.4);
    // a typo must not become a 3x UI nobody can get out of
    expect(boostFor({ layout: 411, screen: 411, visible: null, forced: 9 })).toBe(1);
    // and a normal viewport is still left alone when the override is nonsense
    expect(boostFor({ layout: 980, screen: 411, visible: null, forced: 9 })).toBe(2.38);
  });
});

describe("appHeightFor", () => {
  it("uses the height the user can actually see", () => {
    expect(appHeightFor({ layout: 411, screen: 411, visible: { width: 411, height: 812.4, scale: 1 } })).toBe(812);
  });

  it("leaves the height to CSS when there is no visual viewport", () => {
    expect(appHeightFor({ layout: 411, screen: 411, visible: null })).toBe(0);
    expect(appHeightFor({ layout: 411, screen: 411, visible: { width: 411, height: 0, scale: 1 } })).toBe(0);
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

describe("applyBoost", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--u");
    document.documentElement.style.removeProperty("--app-h");
    delete document.documentElement.dataset.fit;
  });

  it("writes the multiplier and the visible height to the root", () => {
    const boost = applyBoost({
      layout: 980,
      screen: 411,
      visible: { width: 980, height: 812, scale: 0.42 },
    });
    expect(boost).toBeCloseTo(2.38, 2);
    expect(document.documentElement.style.getPropertyValue("--u")).toBe("2.38");
    expect(document.documentElement.dataset.fit).toBe("boost");
    expect(document.documentElement.style.getPropertyValue("--app-h")).toBe("812px");
  });

  it("clears both once the viewport is normal again", () => {
    applyBoost({ layout: 980, screen: 411, visible: { width: 980, height: 812, scale: 0.42 } });
    const boost = applyBoost({
      layout: 411,
      screen: 411,
      visible: { width: 411, height: 812, scale: 1 },
    });
    expect(boost).toBe(1);
    expect(document.documentElement.style.getPropertyValue("--u")).toBe("");
    expect(document.documentElement.dataset.fit).toBeUndefined();
    // the height stays: it is still the right height
    expect(document.documentElement.style.getPropertyValue("--app-h")).toBe("812px");
  });
});

describe("applyViewportFit in the browser", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.style.removeProperty("--u");
    document.documentElement.style.removeProperty("--app-h");
    delete document.documentElement.dataset.fit;
  });

  it("reads the live viewport instead of a stored one", () => {
    Object.defineProperty(window.screen, "width", { value: 411, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 980, configurable: true });
    expect(applyViewportFit()).toBeCloseTo(2.38, 2);

    Object.defineProperty(window, "innerWidth", { value: 411, configurable: true });
    expect(applyViewportFit()).toBe(1);
    expect(document.documentElement.style.getPropertyValue("--u")).toBe("");
  });

  it("takes a wrong boost back on its own, without a resize event", async () => {
    // the launch reading: a desktop layout width that the browser then corrects
    Object.defineProperty(window.screen, "width", { value: 411, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 980, configurable: true });
    applyViewportFit();
    expect(document.documentElement.dataset.fit).toBe("boost");

    const stop = watchViewportFit();
    Object.defineProperty(window, "innerWidth", { value: 411, configurable: true });
    // no resize, no orientation change — only time passing
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(document.documentElement.style.getPropertyValue("--u")).toBe("");
    expect(document.documentElement.dataset.fit).toBeUndefined();
    stop();
  });
});
