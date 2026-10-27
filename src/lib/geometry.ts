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

export type CoverFit = { scale: number; dx: number; dy: number; w: number; h: number };

/**
 * Where a tap on the viewfinder lands in the camera's own frame, 0..1.
 *
 * Two things scale between the finger and the sensor, and it is easy to account
 * for only one of them. The frame is drawn with `object-fit: cover`, which is the
 * `scale`/`dx`/`dy` of `coverRect()`; and on a lens that admits to no hardware
 * zoom the preview layer itself is CSS-scaled by `preview` around the middle of
 * the stage. A tap is in stage pixels, `pointsOfInterest` wants a fraction of the
 * frame.
 *
 * Forget the preview scale and the ring appears under the finger while the lens
 * focuses somewhere towards the middle of the page — a "tap to focus" that
 * quietly does nothing visible, the same way a crosshair drawn through the
 * magnifier's zoom quietly disappeared.
 */
export function coverPoint(
  tap: { x: number; y: number },
  map: CoverFit,
  frame: { w: number; h: number },
  preview = 1
): { x: number; y: number } {
  const k = Number.isFinite(preview) && preview > 0 ? preview : 1;
  // undo the preview scale around the stage's centre, back to layer pixels
  const cx = map.w / 2;
  const cy = map.h / 2;
  const lx = cx + (tap.x - cx) / k;
  const ly = cy + (tap.y - cy) / k;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: clamp01((lx - map.dx) / Math.max(1e-6, frame.w * map.scale)),
    y: clamp01((ly - map.dy) / Math.max(1e-6, frame.h * map.scale)),
  };
}

/**
 * The mark in the middle of the magnifier.
 *
 * One small ring around the exact pixel under the corner — nothing else. It used
 * to be a full crosshair, four arms reaching out towards the edge of the loupe;
 * on a sheet of printed text those arms cut straight through the words you were
 * trying to line a corner up with, and they pulled the eye away from the only
 * thing that matters in a loupe, which is the centre. A ring says "this pixel"
 * without covering it.
 *
 * Pure and in screen coordinates on purpose: it is drawn *after* the magnifying
 * transform, and drawing it through that transform is what once made it land
 * hundreds of pixels outside the circle and disappear.
 */
export function centreMark(radius: number): number {
  // grows with the loupe, but only gently: a dot that scales 1:1 turns into a
  // target ring, and this is a magnifier, not a rifle scope
  const scale = Number.isFinite(radius) && radius > 0 ? radius : 58;
  return Math.max(3.5, Math.min(7, scale * 0.086));
}
