import { detectPageQuad } from "./cv";

/**
 * Live page detection for the viewfinder. Runs off the main thread so the
 * preview never stutters while the user moves the phone around.
 */
type Request = { id: number; width: number; height: number; buffer: ArrayBuffer };
type Reply = { id: number; quad: { x: number; y: number }[] | null; ms: number };

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, width, height, buffer } = event.data;
  const started = performance.now();
  let quad: { x: number; y: number }[] | null = null;
  try {
    const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const found = detectPageQuad(img);
    quad = found ? found.map((p) => ({ x: p.x, y: p.y })) : null;
  } catch (err) {
    console.warn("[flatbed] worker detection failed", err);
  }
  const reply: Reply = { id, quad, ms: Math.round(performance.now() - started) };
  (self as unknown as Worker).postMessage(reply);
};
