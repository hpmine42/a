/**
 * Pure geometry helpers that are easy to get subtly wrong, so they are tested
 * instead of eyeballed: the viewport fit and the loupe mapping.
 */

export type Fit = { scale: number; dx: number; dy: number };

/** Contain an image of w×h inside a box of boxW×boxH, centred. */
export function containFit(imgW: number, imgH: number, boxW: number, boxH: number): Fit {
  const scale = Math.min(boxW / imgW, boxH / imgH);
  return { scale, dx: (boxW - imgW * scale) / 2, dy: (boxH - imgH * scale) / 2 };
}

/** CSS point inside the canvas → image pixel. */
export function toImagePoint(p: { x: number; y: number }, fit: Fit): { x: number; y: number } {
  return { x: (p.x - fit.dx) / fit.scale, y: (p.y - fit.dy) / fit.scale };
}

/** Image pixel → CSS point inside the canvas. */
export function toCanvasPoint(p: { x: number; y: number }, fit: Fit): { x: number; y: number } {
  return { x: p.x * fit.scale + fit.dx, y: p.y * fit.scale + fit.dy };
}

export type SourceRect = { sx: number; sy: number; size: number };

/**
 * Which part of the source image a magnifier of CSS radius `radius` shows when
 * it sits on `handle` (CSS coordinates).
 *
 * `zoom` is relative to what the user already sees on screen: one image pixel
 * appears `zoom ×` larger inside the loupe. Getting the fit offset wrong here
 * is what makes a loupe show an area next to the point you are dragging.
 */
export function loupeSourceRect(
  handle: { x: number; y: number },
  fit: Fit,
  radius: number,
  zoom: number
): SourceRect {
  const centre = toImagePoint(handle, fit);
  const size = (radius * 2) / (zoom * fit.scale);
  return { sx: centre.x - size / 2, sy: centre.y - size / 2, size };
}

/** Keep a floating element fully inside a box, preferring the given corner. */
export function clampToBox(
  p: { x: number; y: number },
  radius: number,
  boxW: number,
  boxH: number,
  pad = 8
): { x: number; y: number } {
  return {
    x: Math.max(radius + pad, Math.min(boxW - radius - pad, p.x)),
    y: Math.max(radius + pad, Math.min(boxH - radius - pad, p.y)),
  };
}

export type Segment = { x1: number; y1: number; x2: number; y2: number };

/**
 * The crosshair inside the magnifier.
 *
 * Four arms that stop short of the centre, plus a small ring around the exact
 * pixel: the arms say "look here", the gap and the ring leave the pixel itself
 * visible — which is the whole point of a loupe when you are deciding whether the
 * corner is on the paper's edge or one pixel outside it.
 *
 * Pure and in screen coordinates on purpose. It used to be drawn *through* the
 * transform that magnifies the photo, i.e. screen numbers fed into a source-pixel
 * space, so the crosshair landed far outside the circle and never showed up at
 * all. Geometry that has to be in one space is worth testing in that space.
 */
export function reticle(
  cx: number,
  cy: number,
  radius: number,
  gap = 7,
  ring = 4
): { lines: Segment[]; ring: number } {
  // the arms start outside the ring, so the ring never sits on top of a line
  const inner = gap + ring;
  const outer = Math.max(inner + 6, radius - 6);
  return {
    lines: [
      { x1: cx - outer, y1: cy, x2: cx - inner, y2: cy },
      { x1: cx + inner, y1: cy, x2: cx + outer, y2: cy },
      { x1: cx, y1: cy - outer, x2: cx, y2: cy - inner },
      { x1: cx, y1: cy + inner, x2: cx, y2: cy + outer },
    ],
    ring,
  };
}
