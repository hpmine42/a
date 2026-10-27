/**
 * Page detection off the main thread.
 *
 * The detector is plain, synchronous TypeScript: ~200ms on a desktop and
 * noticeably more on a phone. While it runs, the main thread cannot paint — and
 * a scanning animation that freezes halfway down the page is worse than no
 * animation at all, because it looks like the scan gave up in the middle.
 *
 * So the capture path asks a worker instead (the viewfinder has used the same
 * worker all along). Everything here is best-effort: if workers are missing or
 * crash, the caller gets `null` and falls back to the synchronous detector.
 */

import type { Quad } from "./cv";

type Reply = { id: number; quad?: Quad | null; quads?: Quad[] };

/** A detector that has not answered by now is not going to help this scan. */
const TIMEOUT_MS = 6000;

let worker: Worker | null = null;
let unusable = false;
let nextId = 0;

const waiting = new Map<number, { done: (quads: Quad[] | null) => void; timer: number }>();

function settle(id: number, quads: Quad[] | null): void {
  const entry = waiting.get(id);
  if (!entry) return;
  waiting.delete(id);
  window.clearTimeout(entry.timer);
  entry.done(quads);
}

function failEverything(): void {
  for (const id of [...waiting.keys()]) settle(id, null);
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (unusable) return null;
  if (typeof Worker !== "function") {
    unusable = true;
    return null;
  }
  try {
    worker = new Worker(new URL("./detect.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const data = event.data;
      const quads = data.quads ?? (data.quad ? [data.quad] : []);
      settle(data.id, quads);
    };
    worker.onerror = () => {
      // a worker that cannot even load is not worth a second try
      unusable = true;
      failEverything();
    };
  } catch {
    unusable = true;
    worker = null;
  }
  return worker;
}

/**
 * Send the photo to the worker at a sensible size.
 *
 * Detection works on a 480px copy anyway, so posting a 12MP image would only
 * cost a 40MB copy and a transfer slot. 1600px keeps more detail than the
 * detector uses and stays small enough to move instantly.
 */
function prepare(img: ImageData): { data: ImageData; scale: number } {
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) {
    // copy: the page keeps its own pixels, the worker gets its own buffer
    return { data: new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), scale: 1 };
  }
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { data: new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), scale: 1 };
  }
  ctx.imageSmoothingQuality = "high";
  const source = document.createElement("canvas");
  source.width = img.width;
  source.height = img.height;
  source.getContext("2d")?.putImageData(img, 0, 0);
  ctx.drawImage(source, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h), scale };
}

/**
 * Detect up to `limit` sheets without blocking the UI.
 * Resolves `null` when the worker route is unavailable — the caller then has to
 * do the work on the main thread and live with the pause.
 */
export function detectPageQuadsAsync(
  img: ImageData,
  options: { limit?: number; effort?: "fast" | "thorough" } = {}
): Promise<Quad[] | null> {
  const boss = ensureWorker();
  if (!boss) return Promise.resolve(null);

  const limit = options.limit ?? 2;
  const effort = options.effort ?? "thorough";
  const { data, scale } = prepare(img);
  const id = ++nextId;

  return new Promise<Quad[] | null>((resolve) => {
    const timer = window.setTimeout(() => {
      // a silent worker is a broken worker: let the caller fall back
      unusable = true;
      settle(id, null);
    }, TIMEOUT_MS);
    waiting.set(id, {
      timer,
      done: (quads) =>
        resolve(quads ? quads.map((q) => q.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad) : null),
    });
    try {
      boss.postMessage(
        { id, width: data.width, height: data.height, buffer: data.data.buffer, limit, effort },
        [data.data.buffer]
      );
    } catch {
      settle(id, null);
    }
  });
}

/** Drop the worker (tests, or a page that is being torn down). */
export function disposeDetectWorker(): void {
  worker?.terminate();
  worker = null;
  failEverything();
}
