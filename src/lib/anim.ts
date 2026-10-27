/**
 * Tiny animation helpers.
 *
 * The detection animations have to be short and cheap — they explain what the
 * app just decided, they are not a show. Everything here therefore runs on
 * `requestAnimationFrame`, finishes in a few hundred milliseconds, and is
 * skipped outright when the user asked for less motion.
 */

export type Pt = { x: number; y: number };

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * How long one detection sweep takes to travel a page, top to bottom.
 *
 * The sweep is the promise that the app is looking, and a promise that stops
 * halfway is worse than no animation at all: it reads as "the scan happened in
 * the middle of the page". So it is a single pass with a fixed length, shared by
 * the review sheet and the crop tool, and detection simply waits for it.
 */
export const SWEEP_MS = 620;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Glide a quad from one place to another. Calls `onFrame` with each step and
 * resolves once the last one has been drawn; `ms = 0` jumps straight to the end.
 */
export function glideQuad(
  from: Pt[],
  to: Pt[],
  ms: number,
  onFrame: (quad: Pt[]) => void
): Promise<void> {
  if (ms <= 0 || prefersReducedMotion()) {
    onFrame(to.map((p) => ({ x: p.x, y: p.y })));
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = easeOutCubic(t);
      onFrame(
        to.map((p, i) => ({
          x: from[i].x + (p.x - from[i].x) * e,
          y: from[i].y + (p.y - from[i].y) * e,
        }))
      );
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}
