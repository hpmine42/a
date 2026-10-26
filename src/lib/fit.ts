/* Some phones browse in "desktop site" mode (or the user zoomed the page out
 * far enough that Chrome switched layout widths). The layout viewport then
 * reports ~980px on a ~410px screen, so the browser paints the whole app at
 * roughly 40% — buttons designed at 52px land at 21px and the UI looks like a
 * miniature. Nothing in the component tree can fix that, but we can measure
 * the mismatch and hand CSS one multiplier. */

/** Pure so it can be tested: viewport and screen width in CSS pixels. */
export function viewportBoost(viewport: number, screen: number): number {
  if (!Number.isFinite(viewport) || !Number.isFinite(screen)) return 1;
  // Real phones are 320–600 CSS px wide. Anything larger is a tablet or a
  // desktop window, where the browser is not squeezing the page.
  if (screen < 200 || screen > 620) return 1;
  if (viewport <= 0) return 1;
  const ratio = viewport / screen;
  if (ratio < 1.25) return 1; // layout width matches the screen: nothing to do
  return Math.min(3, Math.round(ratio * 100) / 100);
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

/** Writes the multiplier to `--u`, which every size token in styles.css uses. */
export function applyViewportFit(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 1;
  const boost = Math.max(
    viewportBoost(window.innerWidth, window.screen?.width ?? 0),
    forcedBoost(window.location?.search ?? "")
  );
  const root = document.documentElement;
  if (boost > 1.05) {
    root.style.setProperty("--u", String(boost));
    root.dataset.fit = "boost";
  } else {
    root.style.removeProperty("--u");
    delete root.dataset.fit;
  }
  return boost;
}

/** Keeps the fix applied across rotation and viewport changes. */
export function watchViewportFit(): () => void {
  let frame = 0;
  const run = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      applyViewportFit();
    });
  };
  window.addEventListener("resize", run);
  window.addEventListener("orientationchange", run);
  return () => {
    window.removeEventListener("resize", run);
    window.removeEventListener("orientationchange", run);
    if (frame) cancelAnimationFrame(frame);
  };
}
