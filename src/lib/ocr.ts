/**
 * Text recognition, on the device.
 *
 * The engine is Tesseract compiled to WebAssembly (the `tesseract.js` package),
 * served from our own origin — see `scripts/fetch-ocr-assets.mjs`. Nothing is
 * sent anywhere: the recogniser runs in a worker in the tab, and once the four
 * files have been fetched once, the phone's cache keeps them, so it works with
 * no connection at all.
 *
 * Everything heavy is lazy. `tesseract.js`, its worker and its 5 MB of engine and
 * language data are only touched when the user asks for text on a page — a
 * scanner that ships a language model to people who never open that panel is a
 * scanner that takes ten seconds to load.
 */

export type OcrStage = "engine" | "language" | "text";

export type OcrProgress = { stage: OcrStage; value: number };

/**
 * One recognised word.
 *
 * `box` is `[left, top, right, bottom]` in *fractions of the page* (0..1), not in
 * pixels: the same word has to land in the right place on a 900px preview and on
 * a 3000px export, and fractions are the only coordinates that survive both.
 */
export type OcrWord = {
  text: string;
  box: [number, number, number, number];
  confidence: number;
};

export type OcrPage = {
  /** The page as text, line breaks included — what the text panel shows. */
  text: string;
  words: OcrWord[];
  /** Mean confidence, 0..100, as Tesseract reports it. */
  confidence: number;
  /** Size of the image that was recognised, so a box can be traced back. */
  width: number;
  height: number;
  /** When it was recognised: re-running is cheap, but not free. */
  at: number;
};

export type OcrFailure =
  /** The engine could not be fetched (offline before the first download). */
  | "engine"
  /** The page had no pixels to read. */
  | "empty";

export class OcrError extends Error {
  constructor(readonly reason: OcrFailure) {
    super(reason === "engine" ? "The text engine is not available" : "nothing to read");
    this.name = "OcrError";
  }
}

/* --------------------------------------------------------------- the engine */

type TessWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
type TessPage = {
  text: string;
  confidence: number;
  blocks?: { paragraphs: { lines: { words: TessWord[] }[] }[] }[] | null;
  words?: TessWord[];
};
type TessWorker = {
  recognize: (image: unknown, options?: unknown, output?: unknown) => Promise<{ data: TessPage }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};
type TessModule = {
  createWorker: (langs?: string, oem?: number, options?: Record<string, unknown>) => Promise<TessWorker>;
};

let workerPromise: Promise<TessWorker> | null = null;
/** Free the engine's memory when nobody has needed it for a while. */
let idleTimer = 0;
const IDLE_MS = 120_000;

/** Where the four engine files live. Same origin, next to the app. */
function asset(path: string): string {
  return new URL(`ocr/${path}`, document.baseURI).href;
}

async function module(): Promise<TessModule> {
  const loaded = (await import("tesseract.js")) as unknown as {
    createWorker?: TessModule["createWorker"];
    default?: TessModule;
  };
  // a CommonJS module: depending on how it was bundled, it arrives as itself or
  // under `default`
  const create = loaded.createWorker ?? loaded.default?.createWorker;
  if (typeof create !== "function") throw new OcrError("engine");
  return { createWorker: create };
}

async function worker(onProgress?: (p: OcrProgress) => void): Promise<TessWorker> {
  window.clearTimeout(idleTimer);
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    try {
      const { createWorker } = await module();
      const made = await createWorker("eng", 1 /* LSTM only, matching the model */, {
        // absolute, because the worker is spawned from a blob: URL and a
        // relative path inside it would resolve against the blob
        workerPath: asset("worker.min.js"),
        corePath: asset("core/tesseract-core-lstm.wasm.js"),
        langPath: asset("lang"),
        gzip: true,
        // Load the worker from our own URL rather than from a blob: the service
        // worker can only cache a request it sees, and a blob worker escapes it —
        // which is the difference between "works offline after one use" and
        // "works offline on a good day".
        workerBlobURL: false,
        logger: (message: { status?: string; progress?: number }) => {
          if (!onProgress || !message?.status) return;
          const stage: OcrStage = /language|traineddata|initializing api/i.test(message.status)
            ? "language"
            : /recognizing/i.test(message.status)
              ? "text"
              : "engine";
          onProgress({ stage, value: Math.max(0, Math.min(1, message.progress ?? 0)) });
        },
      });
      // A scanned page is one column of text on a sheet, which is what AUTO
      // reads best; preserving the spaces keeps a table row in one line.
      await made.setParameters({ tessedit_pageseg_mode: "3", preserve_interword_spaces: "1" }).catch(() => undefined);
      return made;
    } catch (err) {
      workerPromise = null;
      console.warn("[scano] text engine unavailable", err);
      throw err instanceof OcrError ? err : new OcrError("engine");
    }
  })();
  return workerPromise;
}

/** Release the engine (a phone that has finished scanning should get its RAM back). */
export async function stopOcr(): Promise<void> {
  window.clearTimeout(idleTimer);
  const pending = workerPromise;
  workerPromise = null;
  if (!pending) return;
  try {
    const made = await pending;
    await made.terminate();
  } catch {
    /* it never started, or it is already gone */
  }
}

function armIdleStop(): void {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => void stopOcr(), IDLE_MS);
}

/**
 * Recognise the text on one page.
 *
 * The image is the finished page — warped, straightened, and (if Optimize is on)
 * already flattened to black on white, which is what the engine reads best. The
 * result is normalised to the page, so the caller can lay those words over the
 * image at any size.
 */
export async function recognize(
  image: Blob | HTMLCanvasElement,
  /** Size of that image in pixels — the boxes are normalised with it. */
  size: { width: number; height: number },
  onProgress?: (p: OcrProgress) => void
): Promise<OcrPage> {
  if (size.width < 8 || size.height < 8) throw new OcrError("empty");
  const made = await worker(onProgress);
  onProgress?.({ stage: "text", value: 0 });
  const { data } = await made.recognize(image, {}, { text: true, blocks: true });
  armIdleStop();

  // Words come nested: blocks → paragraphs → lines → words. Older/newer shapes
  // also expose a flat `words`; take whichever is there.
  const flat: TessWord[] = data.words?.length
    ? data.words
    : (data.blocks ?? []).flatMap((block) =>
        (block.paragraphs ?? []).flatMap((paragraph) =>
          (paragraph.lines ?? []).flatMap((line) => line.words ?? [])
        )
      );

  const w = size.width;
  const h = size.height;
  const words: OcrWord[] = [];
  for (const word of flat) {
    const text = (word.text ?? "").trim();
    if (!text) continue;
    const { x0, y0, x1, y1 } = word.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    if (x1 <= x0 || y1 <= y0) continue;
    words.push({
      text,
      confidence: word.confidence ?? 0,
      box: [x0 / w, y0 / h, x1 / w, y1 / h],
    });
  }

  return {
    text: (data.text ?? "").replace(/\n{3,}/g, "\n\n").trim(),
    words,
    confidence: data.confidence ?? 0,
    width: w,
    height: h,
    at: Date.now(),
  };
}

/** How many words a result holds — the panel says it, so it is computed once. */
export function wordCount(ocr: OcrPage | null | undefined): number {
  if (!ocr) return 0;
  if (ocr.words.length) return ocr.words.length;
  return ocr.text.split(/\s+/).filter(Boolean).length;
}
