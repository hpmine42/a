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
