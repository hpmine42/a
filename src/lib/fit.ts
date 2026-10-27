/* Some phones browse in "desktop site" mode (or the user zoomed the page out
 * far enough that Chrome switched layout widths). The layout viewport then
 * reports ~980px on a ~410px screen, so the browser paints the whole app at
 * roughly 40% — buttons designed at 52px land at 21px and the UI looks like a
 * miniature. Nothing in the component tree can fix that, but we can measure
 * the mismatch and hand CSS one multiplier.
 *
 * Two lessons from the other direction, both from a real phone:
 *
 *  - A launch is not a measurement. A PWA cold start can report the desktop
 *    layout width for the first frames, before the viewport meta is honoured.
 *    One sample taken then is a 2.4× UI for the rest of the session, because no
 *    `resize` follows to correct it — "sometimes it opens bigger and you have to
 *    scroll". So the reading is confirmed (visual viewport scale, and repeat
 *    samples after the app is actually up).
 *  - `100dvh` is not the visible height in a standalone app either: the status
 *    bar and the gesture bar can be counted in. The document then scrolls by a
 *    few dozen pixels and the top bar is cut off. The app height comes from
 *    `visualViewport.height` instead, and the shell never scrolls at all.
 */

/** What one look at the browser tells us. Pure and testable. */
export type ViewportReading = {
  /** Layout viewport width in CSS pixels. */
  layout: number;
  /** What the screen offers, in CSS pixels (0 when unknown). */
  screen: number;
  /** The visual viewport, when the browser has one. */
  visible?: { width: number; height: number; scale: number } | null;
  /** `?u=` — an explicit override, always honoured. */
  forced?: number;
};

/** Ceiling for the multiplier: past 3× the UI is a cartoon. */
const MAX_BOOST = 3;

/** Pure so it can be tested: viewport and screen width in CSS pixels. */
export function viewportBoost(viewport: number, screen: number): number {
  if (!Number.isFinite(viewport) || !Number.isFinite(screen)) return 1;
  // Real phones are 320–600 CSS px wide. Anything larger is a tablet or a
  // desktop window, where the browser is not squeezing the page.
  if (screen < 200 || screen > 620) return 1;
  if (viewport <= 0) return 1;
  const ratio = viewport / screen;
  if (ratio < 1.25) return 1; // layout width matches the screen: nothing to do
  return Math.min(MAX_BOOST, Math.round(ratio * 100) / 100);
}

/**
 * How much the browser is shrinking the app — the whole decision, in one place.
 *
 * The visual viewport's `scale` is the honest answer: it says the page is being
 * painted smaller than its layout. The width ratio is the older fallback, and it
 * is only trusted when something else agrees, because a stale layout width from
 * the first frames of a launch looks exactly like desktop-site mode.
 */
export function boostFor(reading: ViewportReading): number {
  const forced = Number(reading.forced ?? 1);
  // an override is a promise to the user, but only inside the sane range: a
  // typo must not turn into a 3× UI they cannot get out of
  if (Number.isFinite(forced) && forced > 1.05 && forced <= MAX_BOOST) return forced;

  const v = reading.visible;
  const scale = v && Number.isFinite(v.scale) ? v.scale : 0;
  if (scale > 0 && scale < 0.95) {
    // The browser really is painting the page at 40%: undo that, exactly.
    return Math.min(MAX_BOOST, Math.round((1 / scale) * 100) / 100);
  }

  const byWidth = viewportBoost(reading.layout, reading.screen);
  if (byWidth <= 1) return 1;
  // Without a visual viewport there is nothing to corroborate with.
  if (!v || !Number.isFinite(v.width) || v.width <= 0) return byWidth;
  // Corroboration: if the app is really laid out 2.4× wider than the screen, the
  // visible area is wide too. A layout width that is stale for a few frames does
  // not survive this test, so it cannot inflate the UI for the whole session.
  return v.width >= reading.screen * 1.25 ? byWidth : 1;
}

/** The height the app should actually occupy, in CSS pixels (0 = let CSS say). */
export function appHeightFor(reading: ViewportReading): number {
  const v = reading.visible;
  if (!v || !Number.isFinite(v.height) || v.height <= 0) return 0;
  // A sub-pixel shake while the browser bar animates is not worth a re-layout.
  return Math.round(v.height);
}

/** Escape hatch: ?u=2.4 forces the scale, for browsers whose weirdness we
 *  cannot measure (or when a pinch-zoom left the page looking small). */
export function forcedBoost(search: string): number {
  const raw = new URLSearchParams(search).get("u");
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 3) return 1;
  return value;
}

function readViewport(): ViewportReading {
  const doc = document.documentElement;
  const vv = window.visualViewport;
  return {
    layout: Math.max(window.innerWidth || 0, doc?.clientWidth || 0),
    screen: window.screen?.width ?? 0,
    visible: vv ? { width: vv.width, height: vv.height, scale: vv.scale } : null,
    forced: forcedBoost(window.location?.search ?? ""),
  };
}

/** Pure core of `applyViewportFit`, so the whole decision stays testable. */
export function applyBoost(reading: ViewportReading): number {
  const boost = boostFor(reading);
  const root = document.documentElement;
  if (boost > 1.05) {
    root.style.setProperty("--u", String(boost));
    root.dataset.fit = "boost";
  } else {
    root.style.removeProperty("--u");
    delete root.dataset.fit;
  }
  const height = appHeightFor(reading);
  if (height) root.style.setProperty("--app-h", `${height}px`);
  else root.style.removeProperty("--app-h");
  return boost;
}

/** Writes the multiplier to `--u`, which every size token in styles.css uses. */
export function applyViewportFit(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 1;
  return applyBoost(readViewport());
}

/**
 * Keeps the fix applied — and, just as important, takes it back.
 *
 * A boost measured during the first frames of a cold start has to be able to
 * disappear again when the real viewport arrives, and that moment does not
 * always come with a `resize` event. So the reading is repeated a few times
 * after the app is up, and whenever the app comes back to the foreground.
 */
export function watchViewportFit(): () => void {
  let frame = 0;
  const run = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      applyViewportFit();
    });
  };
  const timers = [120, 400, 1200, 2400].map((ms) => window.setTimeout(run, ms));
  const onVisible = () => {
    if (!document.hidden) run();
  };

  window.addEventListener("resize", run);
  window.addEventListener("orientationchange", run);
  window.addEventListener("pageshow", run);
  document.addEventListener("visibilitychange", onVisible);
  window.visualViewport?.addEventListener("resize", run);
  // one more, after the first paint: the launch reading is the one to distrust
  requestAnimationFrame(() => requestAnimationFrame(run));

  return () => {
    window.removeEventListener("resize", run);
    window.removeEventListener("orientationchange", run);
    window.removeEventListener("pageshow", run);
    document.removeEventListener("visibilitychange", onVisible);
    window.visualViewport?.removeEventListener("resize", run);
    for (const timer of timers) window.clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
  };
}
