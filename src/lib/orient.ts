/**
 * The two frames of reference a page lives in.
 *
 * A page is stored as the photo (`src`, in the camera's orientation) plus four
 * corners (`quad`) in *source* pixels, and the render runs `warp` and only then
 * turns the result (`page.rotation`). So on screen the page is upright, while
 * the photo behind it may be sideways.
 *
 * The crop tool shows the photo. If it showed it in the source orientation, a
 * page the user had just turned would flip back to sideways the moment they
 * opened the corners — and the crop they then placed would not be the crop they
 * got. So the tool draws the photo in the *view* frame (source turned by
 * `rotation`) and translates the corners both ways:
 *
 *   - handle j sits on the view's corner j (`viewQuad`);
 *   - dragging handle j writes source corner `(j - quarter) mod 4`, which is the
 *     corner that `warp` + turn ends up placing there (`sourceQuad`).
 *
 * Getting that index shift wrong produces a crop that is silently off by a
 * quarter turn, which is why this lives in its own pure, tested module instead
 * of inside an event handler.
 */

export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt];

/** 0 | 1 | 2 | 3 quarter turns clockwise. */
export function quarter(rotation: number): number {
  return (((Math.round(rotation / 90) % 4) + 4) % 4);
}

/** Size of the photo once it is turned. */
export function viewSize(w: number, h: number, q: number): { w: number; h: number } {
  return q % 2 ? { w: h, h: w } : { w, h };
}

/** Source pixel → view pixel (the photo turned `q` quarter turns clockwise). */
export function toView(p: Pt, q: number, w: number, h: number): Pt {
  if (q === 1) return { x: h - p.y, y: p.x };
  if (q === 2) return { x: w - p.x, y: h - p.y };
  if (q === 3) return { x: p.y, y: w - p.x };
  return { x: p.x, y: p.y };
}

/** View pixel → source pixel — the exact inverse of `toView`. */
export function toSource(p: Pt, q: number, w: number, h: number): Pt {
  if (q === 1) return { x: p.y, y: h - p.x };
  if (q === 2) return { x: w - p.x, y: h - p.y };
  if (q === 3) return { x: w - p.y, y: p.x };
  return { x: p.x, y: p.y };
}

/**
 * The source corners, seen from the view.
 *
 * The quad keeps its shape and its place on the paper; only the labels move, so
 * that index 0 is always the corner a person would call "top left" *as they see
 * it now*.
 */
export function viewQuad(quad: Quad, q: number, w: number, h: number): Quad {
  const shift = (j: number) => (j - q + 4) % 4;
  return [0, 1, 2, 3].map((j) => toView(quad[shift(j)], q, w, h)) as Quad;
}

/** The inverse of `viewQuad`: what the renderer needs to reproduce the view. */
export function sourceQuad(view: Quad, q: number, w: number, h: number): Quad {
  const out: Pt[] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  for (let j = 0; j < 4; j++) out[(j - q + 4) % 4] = toSource(view[j], q, w, h);
  return out as Quad;
}

/**
 * Set up a canvas so that drawing the source at (0, 0, w, h) lands in view
 * space. Call inside `save()`/`restore()`; the caller scales and positions.
 */
export function applyView(g: CanvasRenderingContext2D, q: number, w: number, h: number): void {
  if (q === 1) {
    g.translate(h, 0);
    g.rotate(Math.PI / 2);
  } else if (q === 2) {
    g.translate(w, h);
    g.rotate(Math.PI);
  } else if (q === 3) {
    g.translate(0, w);
    g.rotate(-Math.PI / 2);
  }
}
