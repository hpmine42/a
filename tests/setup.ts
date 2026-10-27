/**
 * jsdom environment stubs.
 *
 * The UI is built around canvas, a camera stream and a worker, none of which
 * jsdom implements. These stubs are deliberately dumb — enough to mount the app
 * and drive its state machine, not to judge image quality (that is the job of
 * scripts/test-cv.ts, which runs the real pipeline in Node).
 */

type Ctx2D = Record<string, unknown>;

function makeContext(canvas: HTMLCanvasElement): Ctx2D {
  const ctx: Ctx2D = {
    canvas,
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineCap: "butt",
    font: "",
    imageSmoothingQuality: "low",
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: "transparent",
  };
  for (const name of [
    "save",
    "restore",
    "beginPath",
    "closePath",
    "moveTo",
    "lineTo",
    "arc",
    "rect",
    "fill",
    "stroke",
    "clip",
    "clearRect",
    "fillRect",
    "setTransform",
    "scale",
    "translate",
    "drawImage",
    "putImageData",
    "setLineDash",
    "createLinearGradient",
  ]) {
    ctx[name] = () => undefined;
  }
  ctx.createLinearGradient = () => ({ addColorStop: () => undefined });
  ctx.getImageData = (_x: number, _y: number, w: number, h: number) =>
    new ImageDataSim(Math.max(1, w), Math.max(1, h));
  return ctx;
}

class ImageDataSim {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(a: Uint8ClampedArray | number, b?: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b ?? a;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = a;
      this.width = b ?? 1;
      this.height = c ?? 1;
    }
  }
}

export function denyCamera() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        const err = new Error("denied");
        err.name = "NotAllowedError";
        throw err;
      },
    },
  });
}

export function allowCamera() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => fakeCameraStream(),
      enumerateDevices: async () => [
        { kind: "videoinput", deviceId: "main-back", label: "Back Camera" },
        { kind: "videoinput", deviceId: "ultra-back", label: "Back Ultra Wide Camera" },
        { kind: "audioinput", deviceId: "mic", label: "Microphone" },
      ],
    },
  });
}

/**
 * What the fake lens admits to.
 *
 * `echo` decides whether a constraint that was applied is reported back in
 * `getSettings()` — that is how the app tells "the browser understood" from
 * "the browser resolved and ignored it", so both paths can be tested.
 */
export const fakeCamera = {
  echo: true,
  /** Every applyConstraints throws: an old browser that knows nothing. */
  failAll: false,
  caps: {} as Record<string, unknown>,
  applied: [] as unknown[],
  reset() {
    fakeCamera.echo = true;
    fakeCamera.failAll = false;
    fakeCamera.caps = {};
    fakeCamera.applied = [];
  },
};

export function fakeCameraStream() {
  const state: Record<string, unknown> = { deviceId: "main-back" };
  const track = {
    stop: () => undefined,
    getCapabilities: () => ({ ...fakeCamera.caps }),
    getSettings: () => ({ ...state }),
    applyConstraints: async (constraints?: MediaTrackConstraints) => {
      fakeCamera.applied.push(constraints);
      if (fakeCamera.failAll) {
        const err = new Error("unsupported");
        err.name = "NotSupportedError";
        throw err;
      }
      const advanced = (constraints?.advanced ?? []) as Record<string, unknown>[];
      if (fakeCamera.echo) {
        for (const set of advanced) Object.assign(state, set);
      }
    },
  };
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/**
 * Canvas behaviour the app has to survive.
 *
 * A canvas past the browser's limits does not throw — `toDataURL` quietly hands
 * back "data:," and every page after it is blank. `blank` reproduces that, and
 * `calls` counts the attempts so a retry is visible.
 */
export const fakeCanvas = {
  blank: false,
  /** Blank only for the first n calls — a transient failure, not a dead canvas. */
  blankCalls: 0,
  calls: 0,
  /** A real-looking base64 payload: long enough to be a plausible JPEG. */
  url: "data:image/jpeg;base64," + "A".repeat(2000),
  reset() {
    fakeCanvas.blank = false;
    fakeCanvas.blankCalls = 0;
    fakeCanvas.calls = 0;
  },
};

export function installDomStubs() {
  const g = globalThis as unknown as Record<string, unknown>;

  g.ImageData = ImageDataSim;

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return makeContext(this);
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toDataURL = () => {
    fakeCanvas.calls++;
    const transient = fakeCanvas.calls <= fakeCanvas.blankCalls;
    return fakeCanvas.blank || transient ? "data:," : fakeCanvas.url;
  };

  // jsdom lays nothing out: the overlay would report 0x0 and every "where on the
  // screen did that tap land" calculation would bail out before it ran
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 400,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });

  // no encoder in jsdom: hand back a tiny blob so the persistence path runs
  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    callback: BlobCallback
  ) {
    fakeCanvas.calls++;
    const transient = fakeCanvas.calls <= fakeCanvas.blankCalls;
    // a canvas that cannot be encoded hands back null, exactly like Chrome
    if (fakeCanvas.blank || transient) return callback(null);
    callback(new Blob([fakeCanvas.url.slice(23)], { type: "image/jpeg" }));
  } as unknown as typeof HTMLCanvasElement.prototype.toBlob;

  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = RO;

  /**
   * Worker stub: when `__workerQuad` is set, it answers every detection request
   * with that quad, so the "outline visible → use it" path can be exercised.
   */
  class FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage(msg: { id: number }) {
      const quad = (globalThis as unknown as { __workerQuad?: unknown }).__workerQuad;
      if (!quad) return;
      window.setTimeout(() => {
        this.onmessage?.({ data: { id: msg.id, quad } } as MessageEvent);
      }, 0);
    }
    terminate() {
      this.onmessage = null;
    }
  }
  g.Worker = FakeWorker;

  // a video element with real dimensions, so the capture path can run
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
    configurable: true,
    get: () => 1280,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
    configurable: true,
    get: () => 960,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "readyState", {
    configurable: true,
    get: () => 4,
  });

  g.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0);
  g.cancelAnimationFrame = (id: number) => window.clearTimeout(id);

  denyCamera();

  g.createImageBitmap = async () => ({ width: 240, height: 320, close: () => undefined });

  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: async () => undefined,
  });

  // jsdom rejects arbitrary objects on srcObject; the app only assigns a stream
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get(this: HTMLMediaElement & { _src?: unknown }) {
      return this._src ?? null;
    },
    set(this: HTMLMediaElement & { _src?: unknown }, value: unknown) {
      this._src = value;
    },
  });
}

installDomStubs();
