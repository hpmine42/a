<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { Pt, Quad } from "../lib/cv";
import { bitmapToImageData, cropRegion, imageDataFromFile, looksLikePhoto } from "../lib/image";
import {
  installedRelatedApps,
  isStaleInstall,
  isStandaloneDisplay,
  promptInstall,
  shouldOfferInstall,
  watchInstallPrompt,
} from "../lib/install";
import { coverPoint } from "../lib/geometry";
import { tap, thump } from "../lib/haptics";
import { IMPORT_MAX } from "../lib/store";

/**
 * The Image Capture focus constraints. TypeScript's DOM lib knows
 * `pointsOfInterest` on `InputDeviceInfo` but not on a track constraint, and the
 * browsers that implement it accept exactly this shape.
 */
type FocusConstraint = MediaTrackConstraintSet & {
  pointsOfInterest?: { x: number; y: number }[];
  focusMode?: string;
};
type FocusConstraints = Omit<MediaTrackConstraints, "advanced"> & {
  advanced?: FocusConstraint[];
};

const props = defineProps<{
  thumbs: string[];
  pageCount: number;
  restored?: number;
  /** A picked photo is still being decoded (the app owns that work). */
  decoding?: boolean;
}>();
const emit = defineEmits<{
  (
    e: "captured",
    payload: { img: ImageData; quad: Quad | null; auto: boolean; origin: "camera" | "upload" }
  ): void;
  /** Photos picked from the library; the app opens them one at a time. */
  (e: "files", files: File[]): void;
  /** Something to tell the user that is not about the viewfinder. */
  (e: "notice", message: string): void;
  (e: "open-pages"): void;
}>();

const stage = ref<HTMLDivElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
const overlay = ref<HTMLCanvasElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const error = ref<"denied" | "missing" | null>(null);
const ready = ref(false);
/** Detection is opt-in: it costs battery and can be distracting. */
const autoOn = ref(false);
/** A photo is being decoded from the library — the viewfinder says so. */
const loading = ref(false);

/** Remember the Detect switch: a preference, not a per-photo decision. */
const DETECT_KEY = "scano.detect";

function rememberedDetect(): boolean {
  try {
    return window.localStorage.getItem(DETECT_KEY) === "1";
  } catch {
    return false;
  }
}
const torchOn = ref(false);
const torchAvailable = ref(false);
const facing = ref<"environment" | "user">("environment");
const flash = ref(false);

/* -------------------------------------------------------------------- zoom */

/** Hardware zoom range reported by the track, when the lens supports it. */
const zoomCaps = ref<{ min: number; max: number; step: number } | null>(null);
/** Current optical/digital zoom (1 = whatever the lens gives by default). */
const zoom = ref(1);
/** Fallback zoom for phones that expose no zoom capability: scale the preview. */
const softZoom = ref(1);
/** A second, wider lens — the "0.5×" camera. */
const ultraId = ref<string | null>(null);
const usingUltra = ref(false);

const zoomValue = computed(() => (usingUltra.value ? 0.5 : zoom.value * softZoom.value));
const zoomLabel = computed(() => `${zoomValue.value.toFixed(1)}×`);
const showZoomRow = computed(() => ready.value);
/**
 * The chips already say "1×" and "2×", so repeating "1.0×" beside them read as a
 * third, broken chip. The number is only worth its space between the presets,
 * where a chip cannot show what the pinch actually did.
 */
const showZoomValue = computed(() => {
  if (usingUltra.value) return false;
  const z = zoomValue.value;
  return Math.abs(z - 1) > 0.06 && Math.abs(z - 2) > 0.1;
});

/* ---------------------------------------------------------------- install */

const standalone = ref(false);
const promptReady = ref(false);
const staleInstall = ref(false);
const fixOpen = ref(false);
const offerInstall = computed(() => shouldOfferInstall({ promptReady: promptReady.value, standalone: standalone.value }));
let unwatchInstall: (() => void) | null = null;

async function detectInstallState() {
  const matches =
    typeof window.matchMedia === "function" ? window.matchMedia("(display-mode: standalone)").matches : false;
  standalone.value = isStandaloneDisplay(matches, (window.navigator as { standalone?: boolean }).standalone);
  // only ask when this is the browser: inside the app the answer is "us"
  if (standalone.value) {
    staleInstall.value = false;
    return;
  }
  staleInstall.value = isStaleInstall(await installedRelatedApps(), standalone.value);
}

async function installNow() {
  const outcome = await promptInstall();
  promptReady.value = false;
  if (outcome === "accepted") staleInstall.value = false;
}

type ZoomRange = { min: number; max: number; step: number };
function zoomCapability(track: MediaStreamTrack | undefined): ZoomRange | undefined {
  const caps = (track?.getCapabilities?.() ?? {}) as { zoom?: ZoomRange };
  return caps.zoom;
}

let stream: MediaStream | null = null;
/** The main lens, remembered so the user can come back from the wide one. */
let mainDeviceId: string | null = null;
/** When the last video frame actually arrived — the freeze detector's clock. */
let lastFrameAt = 0;
let lastClock = -1;
let resuming = false;
/** Earliest time the next automatic restart may happen (anti-thrash). */
let nextRestartAt = 0;
let worker: Worker | null = null;
let raf = 0;
let detecting = false;
let nextDetectAt = 0;
let disposed = false;

const small = document.createElement("canvas");
const smallCtx = small.getContext("2d", { willReadFrequently: true });

/** Latest detection in video pixel coordinates. */
const target = ref<Quad | null>(null);
const eased = ref<Quad | null>(null);
const lastReqId = ref(0);
/** The preview stopped producing frames and nothing brought it back. */
const frozen = ref(false);

/* ------------------------------------------------------------- auto shutter */

/** Take the photo once the outline has sat still. Opt-in, and only meaningful
 *  with detection on — otherwise there is no outline to wait for. */
const AUTO_SHOT_KEY = "scano.autoshot";
const autoShot = ref(false);
/** When the outline last started being still (0 = not still). */
let stableSince = 0;
let lastAutoAt = 0;
let capturing = false;
/** How far the outline may wander and still count as "held still". */
function stillEnough(prev: Quad | null, next: Quad | null): boolean {
  if (!prev || !next) return false;
  const v = video.value;
  const span = v?.videoWidth ? Math.hypot(v.videoWidth, v.videoHeight) : 1000;
  const drift = next.reduce((sum, p, i) => sum + Math.hypot(p.x - prev[i].x, p.y - prev[i].y), 0) / 4;
  return drift < span * 0.012;
}

function rememberedAuto(): boolean {
  try {
    return window.localStorage.getItem(AUTO_SHOT_KEY) === "1";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ camera */

async function startStream(mode: "environment" | "user", deviceId?: string, keepView = false) {
  // A restart must not silently undo the setup: a torch that was on, and the
  // zoom the user picked, are part of what they were looking at.
  const restoreLight = keepView && torchOn.value;
  const restoreZoom = keepView ? zoom.value * softZoom.value : 1;
  stopStream();
  error.value = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 2560 }, height: { ideal: 1440 } }
        : {
            facingMode: { ideal: mode },
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
      audio: false,
    });
  } catch (err) {
    const name = (err as DOMException)?.name ?? "";
    error.value = name === "NotAllowedError" || name === "SecurityError" ? "denied" : "missing";
    return;
  }
  const el = video.value;
  if (!el) return;
  el.srcObject = stream;
  try {
    await el.play();
  } catch {
    /* autoplay can fail before the element is visible; the loop retries */
  }
  ready.value = true;
  stampFrame();
  watchFrames(el);
  frozen.value = false;

  const track = stream.getVideoTracks()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean; focusMode?: string[] };
  torchAvailable.value = Boolean(caps.torch);
  focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
  torchOn.value = false;

  const z = zoomCapability(track);
  zoomCaps.value = z ? { min: z.min ?? 1, max: z.max ?? 1, step: z.step ?? 0.1 } : null;
  zoom.value = 1;
  softZoom.value = 1;

  if (restoreLight && torchAvailable.value) {
    try {
      await track?.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] });
      torchOn.value = true;
    } catch {
      torchAvailable.value = false;
    }
  }
  if (restoreZoom > 1.01) await applyZoom(restoreZoom);

  void findUltraWide();
}

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ready.value = false;
}

/**
 * A phone that locks, or a browser that loses focus, can quietly kill the
 * camera track while leaving a perfectly good-looking <video> element showing
 * its last frame. Nothing throws, nothing ends, the picture is simply frozen
 * until the user reloads — the single most annoying bug a camera app can have.
 *
 * So the preview is measured, not assumed: every frame that arrives stamps a
 * clock, and coming back to the app checks that clock. A stale clock restarts
 * the stream once; if even that does not produce frames, the viewfinder offers
 * a tap-to-restart instead of pretending everything is fine.
 */
function stampFrame() {
  lastFrameAt = performance.now();
}

function watchFrames(el: HTMLVideoElement) {
  const withCallback = el as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  };
  if (typeof withCallback.requestVideoFrameCallback !== "function") return;
  const onFrame = () => {
    stampFrame();
    if (!disposed && video.value) watchFrames(video.value);
  };
  try {
    withCallback.requestVideoFrameCallback(onFrame);
  } catch {
    /* not every browser that has the API lets you call it here */
  }
}

/** True when the preview is showing something, but it is not moving. */
function looksFrozen(): boolean {
  if (!ready.value) return false;
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState === "ended") return true;
  // a stream that reports no frame size cannot be photographed either
  if (!video.value?.videoWidth) return true;
  return performance.now() - lastFrameAt > 1400;
}

/**
 * Bring the preview back. Cheap when it is fine (a `play()` at most), a full
 * restart when it is not — the same two steps a user would do by hand, minus
 * the reload.
 */
async function ensureLive(force = false) {
  if (resuming || disposed) return;
  const el = video.value;
  if (!el) return;

  // a stream that never started (or died outright) deserves another go, but
  // never one against a permission the user actually refused
  const dead = !ready.value && error.value !== "denied";
  const stale = ready.value && looksFrozen();
  if (!force && performance.now() < nextRestartAt && (dead || stale)) return;
  if (!force && !dead && !stale) {
    if (el.paused) {
      try {
        await el.play();
      } catch {
        /* still not allowed; the freeze check will catch it */
      }
    }
    return;
  }

  // A restart costs a permission prompt on some phones and a black flash on
  // all of them: at most one every six seconds.
  nextRestartAt = performance.now() + 6000;
  resuming = true;
  try {
    const device = usingUltra.value ? ultraId.value ?? undefined : mainDeviceId ?? undefined;
    await startStream(facing.value, device, true);
    if (ready.value) {
      stampFrame();
      watchFrames(el);
      frozen.value = false;
    }
  } finally {
    resuming = false;
  }
  // a restart that produced no frames within a moment is not a fix
  window.setTimeout(() => {
    if (!disposed) frozen.value = ready.value && looksFrozen();
  }, 900);
}

/** The last resort: restart on demand, from a tap the user can always make. */
async function rewake() {
  tap();
  frozen.value = false;
  await ensureLive(true);
}

const onVisibility = () => {
  if (document.hidden) return;
  void ensureLive();
};

/**
 * Look for a second rear camera. Browsers only expose labels after permission,
 * so this runs once a stream exists. iOS names it "Back Ultra Wide Camera",
 * Android usually "camera2 2, facing back" or contains "wide".
 */
async function findUltraWide() {
  if (facing.value !== "environment" || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const back = devices.filter((d) => d.kind === "videoinput");
    const currentId = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    const ultra = back.find((d) => {
      const label = d.label.toLowerCase();
      if (!label || d.deviceId === currentId) return false;
      return /ultra|0[.,]5|wide angle|超广角|ultraweit/.test(label);
    });
    ultraId.value = ultra?.deviceId ?? null;
  } catch {
    ultraId.value = null;
  }
}

/** Switch to the wide lens, or back to the main one. */
async function toggleUltra() {
  if (!ultraId.value) return;
  const main = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? undefined;
  usingUltra.value = !usingUltra.value;
  target.value = null;
  eased.value = null;
  if (usingUltra.value) {
    const id = ultraId.value;
    await startStream(facing.value, id);
    // keep the reference to the main lens for switching back
    mainDeviceId = main ?? null;
  } else {
    await startStream(facing.value, mainDeviceId ?? undefined);
  }
}

/** Change zoom: real camera zoom when available, scaled preview otherwise. */
async function applyZoom(next: number) {
  const caps = zoomCaps.value;
  const clamped = Math.min(8, Math.max(0.5, next));
  if (caps && caps.max > caps.min) {
    const value = Math.min(caps.max, Math.max(caps.min, clamped));
    try {
      const track = stream?.getVideoTracks()[0];
      await track?.applyConstraints({
        advanced: [{ zoom: value } as unknown as MediaTrackConstraintSet],
      } as MediaTrackConstraints);
      zoom.value = value;
      softZoom.value = 1;
      return;
    } catch {
      zoomCaps.value = null;
    }
  }
  // no zoom on this lens: scale the preview and crop on capture
  softZoom.value = clamped;
}

async function toggleTorch() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const next = !torchOn.value;
  try {
    await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
    torchOn.value = next;
  } catch {
    torchAvailable.value = false;
  }
}

async function flipCamera() {
  facing.value = facing.value === "environment" ? "user" : "environment";
  usingUltra.value = false;
  ultraId.value = null;
  mainDeviceId = null;
  target.value = null;
  eased.value = null;
  await startStream(facing.value);
}

/* -------------------------------------------------------------------- pinch */

const pointers = new Map<number, { x: number; y: number }>();
let pinchStart = 0;
let pinchBase = 1;
/**
 * Focus state.
 *
 * `focusRing` is where the ring is drawn, `focusSeq` restarts its animation so a
 * second tap is visible, and `focusModes` is what the lens admits to supporting.
 * A tap only ever reports something that actually happened: if the lens cannot
 * take a focus point, the ring is drawn where the camera really focuses (the
 * middle), and if nothing could be applied the viewfinder says so once.
 */
const focusRing = ref<{ x: number; y: number } | null>(null);
const focusSeq = ref(0);
const focusNotice = ref<string | null>(null);
let focusTimer = 0;
let focusNoticeTimer = 0;
/** Puts the lens back on continuous autofocus after a tap. */
let focusArmTimer = 0;
let focusModes: string[] = [];
let tapStart = { x: 0, y: 0, at: 0 };
/** A tap that started on a chip or the shutter is a button press, not a focus. */
let tapEligible = false;

/**
 * Tap to focus.
 *
 * Autofocus on a phone picks the middle of a desk edge more often than the
 * paper, and a sharp page is the whole product. `pointsOfInterest` is not
 * implemented everywhere, so this is best-effort: the ring always appears
 * (so the tap never feels ignored), the constraint is applied where it works.
 */
async function focusAt(clientX: number, clientY: number) {
  const el = stage.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  /*
   * Feedback first, hardware second.
   *
   * The previous version only drew the ring after the lens confirmed the focus
   * point — and because most browsers resolve an unknown constraint without
   * reporting it back, "confirmed" almost never happened, so a tap did nothing
   * at all. A tap is a request; what the phone can honour varies by browser.
   * So the ring and the haptic come immediately, always, and the focus request
   * follows. If literally nothing could be asked for, the ring stays honest with
   * a one-line note.
   */
  tap();
  focusRing.value = { x, y };
  focusSeq.value++;
  window.clearTimeout(focusTimer);
  focusTimer = window.setTimeout(() => (focusRing.value = null), 900);

  const track = stream?.getVideoTracks()[0];
  const map = coverRect();
  const v = video.value;
  if (!track) {
    noteFocusUnavailable();
    return;
  }
  if (!map || !v?.videoWidth) return;

  /**
   * The tap, as the camera's normalised coordinates (0..1 of the frame).
   *
   * `softZoom` is part of the answer: when the lens has no hardware zoom the
   * preview is scaled in CSS instead, so the picture under the finger is a
   * magnified crop of the frame — not the frame itself. Mapping without it put
   * the focus point closer to the middle than the ring the user had just seen.
   */
  const point = coverPoint(
    { x, y },
    map,
    { w: v.videoWidth, h: v.videoHeight },
    softZoom.value
  );
  const canSingleShot = focusModes.includes("single-shot");

  /**
   * Ask for the tap, then for a plain refocus, then give up quietly.
   *
   * These are tried unconditionally rather than gated on `getCapabilities()`:
   * reports are patchy (several Android builds list no focus modes at all while
   * accepting them), and a resolved `applyConstraints` is taken as acceptance —
   * Chrome applies `pointsOfInterest` without ever echoing it in `getSettings()`,
   * so requiring the echo rejected a request that had actually worked.
   */
  const attempts: FocusConstraint[] = [
    { pointsOfInterest: [point] },
    { pointsOfInterest: [point], focusMode: "single-shot" },
    { focusMode: "single-shot" },
  ];

  let applied = false;
  for (const constraints of attempts) {
    try {
      await track.applyConstraints({ advanced: [constraints] } as FocusConstraints);
      applied = true;
      break;
    } catch {
      /* the next, less demanding request */
    }
  }

  if (!applied) {
    noteFocusUnavailable();
    return;
  }

  // Leaving the lens on single-shot freezes it at one distance, which is what
  // makes a camera feel broken on the next shot. Hand it back to continuous.
  if (canSingleShot && focusModes.includes("continuous")) {
    window.clearTimeout(focusArmTimer);
    focusArmTimer = window.setTimeout(() => {
      void track
        .applyConstraints({ advanced: [{ focusMode: "continuous" }] } as FocusConstraints)
        .catch(() => undefined);
    }, 1600);
  }
}

/** One honest line, once, instead of a ring that means nothing. */
function noteFocusUnavailable() {
  if (focusNotice.value) return;
  window.clearTimeout(focusNoticeTimer);
  focusNotice.value = "This lens focuses by itself";
  focusNoticeTimer = window.setTimeout(() => (focusNotice.value = null), 2200);
}

/** Pixel distance between the two fingers currently on the stage. */
function distance(): number {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onPointerDown(event: PointerEvent) {
  if (pointers.size === 0) {
    tapStart = { x: event.clientX, y: event.clientY, at: performance.now() };
    tapEligible = !(event.target as HTMLElement | null)?.closest?.("button, a, input, label");
  }
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    pinchStart = distance();
    pinchBase = zoom.value * softZoom.value;
  }
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size !== 2 || !pinchStart) return;
  const ratio = distance() / pinchStart;
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  void applyZoom(pinchBase * ratio);
}

function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchStart = 0;
  // a tap on the picture (not on a chip, not a pinch, not a swipe) focuses there
  const moved = Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y);
  if (pointers.size === 0) {
    if (tapEligible && moved < 12 && performance.now() - tapStart.at < 350) {
      void focusAt(event.clientX, event.clientY);
    }
    tapEligible = false;
  }
}

/* --------------------------------------------------------------- detection */

function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL("../lib/detect.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<{ id: number; quad: Pt[] | null }>) => {
    detecting = false;
    if (event.data.id !== lastReqId.value) return;
    const quad = event.data.quad;
    const v = video.value;
    if (!quad || !v || !v.videoWidth) {
      target.value = null;
      stableSince = 0;
      return;
    }
    const scale = v.videoWidth / small.width;
    const next = quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad;
    // a still outline keeps its clock; a moving one restarts it
    if (!stillEnough(target.value, next)) stableSince = performance.now();
    target.value = next;
  };
}

function grabSmall(): { width: number; height: number; data: ImageData } | null {
  const v = video.value;
  if (!v || v.readyState < 2 || !v.videoWidth || !smallCtx) return null;
  // 320px is enough for a stable outline and keeps the worker call under 60ms
  const scale = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(8, Math.round(v.videoWidth * scale));
  const h = Math.max(8, Math.round(v.videoHeight * scale));
  if (small.width !== w || small.height !== h) {
    small.width = w;
    small.height = h;
  }
  smallCtx.drawImage(v, 0, 0, w, h);
  return { width: w, height: h, data: smallCtx.getImageData(0, 0, w, h) };
}

function scheduleDetection(now: number) {
  if (detecting || !worker || now < nextDetectAt) return;
  if (!autoOn.value || !ready.value || document.hidden) return;
  const frame = grabSmall();
  if (!frame) return;
  detecting = true;
  nextDetectAt = now + 420;
  const id = ++lastReqId.value;
  worker.postMessage(
    { id, width: frame.width, height: frame.height, buffer: frame.data.data.buffer },
    [frame.data.data.buffer]
  );
}

/* ----------------------------------------------------------------- drawing */

function coverRect(): { scale: number; dx: number; dy: number; w: number; h: number } | null {
  const v = video.value;
  const el = overlay.value;
  if (!v || !el || !v.videoWidth) return null;
  // clientWidth, not getBoundingClientRect: the stage is scaled while pinching
  // and the overlay must keep drawing in its own layout pixels
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h) return null;
  const scale = Math.max(w / v.videoWidth, h / v.videoHeight);
  return { scale, dx: (w - v.videoWidth * scale) / 2, dy: (h - v.videoHeight * scale) / 2, w, h };
}

function ease(current: Quad | null, next: Quad | null, t: number): Quad | null {
  if (!current) return next;
  if (!next) return null;
  return current.map((p, i) => ({
    x: p.x + (next[i].x - p.x) * t,
    y: p.y + (next[i].y - p.y) * t,
  })) as Quad;
}

/** Did the last frame put anything on the overlay? */
let overlayPainted = false;

function draw() {
  const canvas = overlay.value;
  const v = video.value;
  if (!canvas || !v) return;
  // With detection off there is nothing to draw, so the loop must not clear a
  // megapixel canvas 60 times a second for no reason — that is pure battery.
  const painting = autoOn.value && Boolean(target.value || eased.value);
  if (!painting && !overlayPainted) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = { width: canvas.clientWidth || 0, height: canvas.clientHeight || 0 };
  if (!rect.width || !rect.height) return;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  overlayPainted = painting;

  const map = coverRect();
  if (!map) return;

  eased.value = ease(eased.value, target.value, 0.24);
  const quad = eased.value;
  if (!quad || !autoOn.value) return;

  const pts = quad.map((p) => ({ x: p.x * map.scale + map.dx, y: p.y * map.scale + map.dy }));

  // frame the sheet without shouting
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, rect.width, rect.height);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(8, 9, 11, 0.3)";
  ctx.fill("evenodd");
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // amber corner brackets: the "locked on" signal
  const side = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  const bracket = Math.min(30, Math.max(16, side * 0.18));
  ctx.strokeStyle = "#ffc061";
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const prev = pts[(i + 3) % 4];
    const next = pts[(i + 1) % 4];
    const norm = (q: Pt) => {
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      return { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
    };
    const a = norm(prev);
    const b = norm(next);
    ctx.beginPath();
    ctx.moveTo(p.x + a.x * bracket, p.y + a.y * bracket);
    ctx.lineTo(p.x, p.y);
    ctx.lineTo(p.x + b.x * bracket, p.y + b.y * bracket);
    ctx.stroke();
  }
}

/** Fire the shutter when the page has been held still long enough. */
function maybeAutoShoot(now: number) {
  if (!autoShot.value || !autoOn.value || !ready.value || capturing || frozen.value) return;
  if (!target.value || !stableSince) return;
  if (now - stableSince < 900 || now - lastAutoAt < 2400) return;
  lastAutoAt = now;
  stableSince = 0;
  void capture();
}

function loop(now: number) {
  if (disposed) return;
  // A playing video advances currentTime every frame; a frozen one does not.
  // That is the fallback clock for browsers without requestVideoFrameCallback.
  const v = video.value;
  if (v && v.readyState >= 2) {
    if (v.currentTime !== lastClock) {
      lastClock = v.currentTime;
      stampFrame();
    }
  }
  if (!document.hidden) {
    scheduleDetection(now);
    draw();
    maybeAutoShoot(now);
  }
  raf = requestAnimationFrame(loop);
}

/* ----------------------------------------------------------------- capture */

async function capture() {
  const v = video.value;
  if (!v || !v.videoWidth || capturing) return;
  capturing = true;
  thump();
  flash.value = true;
  window.setTimeout(() => (flash.value = false), 220);
  try {
    const img = bitmapToImageData(v, IMPORT_MAX);
    // A visible outline means the sheet was already found: use it, do not ask.
    const live = autoOn.value ? target.value : null;
    let quad: Quad | null = null;
    if (live) {
      const scale = img.width / v.videoWidth;
      quad = live.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad;
    }
    // if we had to fake the zoom in the preview, keep what the user framed
    const cropped = softZoom.value > 1.02 ? cropRegion(img, softZoom.value) : img;
    if (quad && softZoom.value > 1.02) {
      const s = 1 / softZoom.value;
      const ox = (img.width - cropped.width) / 2;
      const oy = (img.height - cropped.height) / 2;
      quad = quad.map((p) => ({ x: (p.x - ox) * s, y: (p.y - oy) * s })) as Quad;
    }
    emit("captured", { img: cropped, quad, auto: autoOn.value, origin: "camera" });
  } catch (err) {
    // A shutter that flashes and produces nothing is the worst kind of silence.
    console.error("[scanner] capture failed", err);
    emit("notice", "The photo could not be taken — try again.");
  } finally {
    capturing = false;
  }
}

async function useDemo() {
  tap();
  loading.value = true;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/letter.jpg`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], "demo-invoice.jpg", { type: blob.type || "image/jpeg" });
    const img = await imageDataFromFile(file, IMPORT_MAX);
    // the demo photo has no live viewfinder, so let the detector decide
    emit("captured", { img, quad: null, auto: false, origin: "upload" });
  } catch (err) {
    console.error("[scanner] demo photo unavailable", err);
    emit("notice", "The demo photo did not load — check your connection, then try again.");
  } finally {
    loading.value = false;
  }
}

/**
 * Hand the picked files to the app.
 *
 * The picking happens here, the *opening* does not: as soon as the first photo
 * is decoded the sheet replaces this camera, and a loop that lived here would be
 * cut off after one photo. A file that cannot be a photo at all is still refused
 * here, in words.
 */
function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  input.value = "";
  if (!picked.length) return;
  tap();
  if (!picked.some(looksLikePhoto)) {
    emit("notice", "That file is not a photo — pick a JPEG or PNG.");
    return;
  }
  emit("files", picked);
}

/* ------------------------------------------------------------------ mount */

let observer: ResizeObserver | null = null;
let wakeTimer = 0;

onMounted(async () => {
  ensureWorker();
  autoOn.value = rememberedDetect();
  autoShot.value = rememberedAuto();
  unwatchInstall = watchInstallPrompt({
    onAvailable: () => (promptReady.value = true),
    onInstalled: () => {
      standalone.value = true;
      staleInstall.value = false;
      promptReady.value = false;
    },
  });
  void detectInstallState();
  window.addEventListener("focus", detectInstallState);
  // three ways a phone can come back: a tab switch, a bfcache restore, a focus
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onVisibility);
  await startStream(facing.value);
  raf = requestAnimationFrame(loop);
  observer = new ResizeObserver(() => draw());
  if (stage.value) observer.observe(stage.value);
  // A camera can also die while the app never lost focus (another app grabbing
  // the lens, a thermal stop). This is the cheap heartbeat that notices.
  wakeTimer = window.setInterval(() => {
    if (!document.hidden) void ensureLive();
  }, 2500);
});

onBeforeUnmount(() => {
  disposed = true;
  window.clearInterval(wakeTimer);
  window.clearTimeout(focusTimer);
  window.clearTimeout(focusNoticeTimer);
  window.clearTimeout(focusArmTimer);
  unwatchInstall?.();
  window.removeEventListener("focus", detectInstallState);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pageshow", onVisibility);
  cancelAnimationFrame(raf);
  observer?.disconnect();
  worker?.terminate();
  worker = null;
  stopStream();
});

watch(autoShot, (on) => {
  try {
    window.localStorage.setItem(AUTO_SHOT_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the switch simply forgets */
  }
  if (!on) stableSince = 0;
});

watch(autoOn, (on) => {
  try {
    window.localStorage.setItem(DETECT_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the switch simply forgets */
  }
  if (!on) {
    target.value = null;
    eased.value = null;
    stableSince = 0;
  }
});
</script>

<template>
  <div class="camera">
    <div
      class="camera-stage"
      ref="stage"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="camera-zoom" :style="{ transform: `scale(${softZoom})` }">
        <video ref="video" class="camera-video" playsinline muted autoplay />
        <canvas ref="overlay" class="camera-overlay" />
      </div>
      <div class="vignette" aria-hidden="true" />

      <div class="camera-top">
        <div class="brand"><span class="brand-name">Scano</span></div>

        <div class="camera-top-right">
          <button
            class="control"
            :class="{ on: autoOn }"
            :aria-pressed="autoOn"
            aria-label="Detect the page while framing"
            @click="autoOn = !autoOn"
          >
            <Icon name="auto" :size="19" />
            <span>Detect</span>
          </button>

          <button
            v-if="autoOn"
            class="control"
            :class="{ on: autoShot }"
            :aria-pressed="autoShot"
            aria-label="Take the photo automatically once the page holds still"
            @click="autoShot = !autoShot"
          >
            <Icon name="camera" :size="19" />
            <span>Auto</span>
          </button>

          <button
            v-if="torchAvailable"
            class="control"
            :class="{ on: torchOn }"
            :aria-pressed="torchOn"
            aria-label="Torch"
            @click="toggleTorch"
          >
            <Icon :name="torchOn ? 'flash' : 'flash-off'" :size="19" />
            <span>Light</span>
          </button>
        </div>
      </div>

      <div v-if="showZoomRow" class="zoom-row" role="group" aria-label="Zoom">
        <button
          v-if="ultraId"
          class="zoom-chip"
          :class="{ active: usingUltra }"
          :aria-pressed="usingUltra"
          @click="toggleUltra"
        >
          0.5×
        </button>
        <button
          class="zoom-chip"
          :class="{ active: !usingUltra && Math.abs(zoom * softZoom - 1) < 0.06 }"
          @click="applyZoom(1)"
        >
          1×
        </button>
        <button
          class="zoom-chip"
          :class="{ active: !usingUltra && Math.abs(zoom * softZoom - 2) < 0.1 }"
          @click="applyZoom(2)"
        >
          2×
        </button>
        <span v-if="showZoomValue" class="zoom-value" aria-live="polite">{{ zoomLabel }}</span>
      </div>

      <p v-if="props.restored" class="restored-chip" role="status">
        {{ props.restored === 1 ? "1 page" : `${props.restored} pages` }} from last time
      </p>

      <div
        v-if="focusRing"
        :key="focusSeq"
        class="focus-ring"
        :style="{ left: `${focusRing.x}px`, top: `${focusRing.y}px` }"
        aria-hidden="true"
      />

      <button v-if="frozen && ready" class="camera-frozen" @click="rewake">
        <Icon name="camera" :size="18" />
        <span>Preview paused — tap to restart</span>
      </button>

      <Transition name="fade">
        <p v-if="focusNotice" class="focus-note" role="status">{{ focusNotice }}</p>
      </Transition>

      <Transition name="fade">
        <div v-if="loading || props.decoding" class="camera-busy" role="status" aria-live="polite">
          <span class="spinner" />
          <span>Opening photo…</span>
        </div>
      </Transition>

      <div v-if="!ready" class="camera-fallback">
        <template v-if="error">
          <div class="fallback-icon"><Icon name="camera" :size="28" /></div>
          <p class="fallback-title">No camera access</p>
          <p class="fallback-sub">Pick a photo instead — it never leaves the device.</p>
        </template>
        <p v-else class="fallback-sub">Starting camera…</p>
        <div class="fallback-actions">
          <button class="pill primary" @click="fileInput?.click()">Choose photo</button>
          <button class="pill ghost" @click="useDemo">Demo photo</button>
        </div>
      </div>

      <Transition name="fade">
        <div v-if="flash" class="shutter-flash" />
      </Transition>
    </div>

    <div class="camera-dock">
      <button class="dock-action" @click="fileInput?.click()" aria-label="Choose a photo">
        <span class="round"><Icon name="gallery" :size="22" /></span>
        <span class="dock-label">Photos</span>
      </button>

      <button class="shutter" :disabled="!ready" aria-label="Capture page" @click="capture">
        <span class="shutter-ring" />
      </button>

      <button class="dock-action" @click="tap(); flipCamera()" aria-label="Switch camera">
        <span class="round"><Icon name="flip" :size="22" /></span>
        <span class="dock-label">Flip</span>
      </button>

      <button
        v-if="props.thumbs.length"
        class="stack"
        @click="emit('open-pages')"
        :aria-label="`Open ${props.pageCount} scanned pages`"
      >
        <img :src="props.thumbs[props.thumbs.length - 1]" alt="" />
        <span class="stack-badge">{{ props.pageCount }}</span>
      </button>
    </div>

    <div v-if="offerInstall || staleInstall" class="install-bar">
      <template v-if="offerInstall">
        <button class="install-chip" @click="installNow">
          <Icon name="plus" :size="17" />
          <span>Install Scano</span>
        </button>
        <span class="install-note">Works offline, opens without the browser bar</span>
      </template>
      <template v-else>
        <button class="install-chip warn" :aria-expanded="fixOpen" @click="fixOpen = !fixOpen">
          <Icon name="sparkle" :size="17" />
          <span>Fix the installed app</span>
        </button>
        <span class="install-note">An old copy is still on this phone</span>
      </template>
    </div>

    <div v-if="staleInstall && fixOpen" class="install-fix">
      <p>Chrome thinks Scano is already installed, but the entry points at an address that no longer exists. Remove it once, then install again:</p>
      <ol>
        <li>Long-press the Scano icon on the home screen → <b>App info</b> → <b>Uninstall</b>.<br />
          No icon? <b>Settings → Apps → Scano → Uninstall</b>.</li>
        <li>Come back to this page and tap <b>Install Scano</b>.</li>
      </ol>
      <button class="install-close" @click="fixOpen = false">Got it</button>
    </div>

    <p class="camera-hint">
      <span class="live-dot" :class="{ on: autoOn && !!target }" aria-hidden="true" />
      <template v-if="autoOn && target && autoShot">Page found — hold still, shooting</template>
      <template v-else-if="autoOn && target">Page found — it will be used</template>
      <template v-else-if="autoOn">Looking for the page…</template>
      <template v-else>Point at a page and tap the shutter · pinch to zoom</template>
    </p>


    <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFiles" />
  </div>
</template>
