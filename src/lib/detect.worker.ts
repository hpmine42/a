import { detectPageQuad, detectPageQuads, type Quad } from "./cv";

/**
 * Page detection off the main thread — for the viewfinder, which asks many times
 * a second, and for the capture, where a 200ms freeze would stop the scanning
 * animation halfway down the photo.
 */
type Request = {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  /** How many sheets to look for. 1 (the default) is the viewfinder's case. */
  limit?: number;
  effort?: "fast" | "thorough";
};
type Reply = { id: number; quad: Quad | null; quads: Quad[]; ms: number };

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, width, height, buffer, limit = 1, effort = "fast" } = event.data;
  const started = performance.now();
  let quads: Quad[] = [];
  try {
    const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
    if (limit > 1) {
      quads = detectPageQuads(img, { effort }, limit);
    } else {
      const found = detectPageQuad(img, { effort });
      quads = found ? [found] : [];
    }
  } catch (err) {
    console.warn("[scanner] worker detection failed", err);
  }
  const reply: Reply = {
    id,
    quad: quads[0] ?? null,
    quads,
    ms: Math.round(performance.now() - started),
  };
  (self as unknown as Worker).postMessage(reply);
};
