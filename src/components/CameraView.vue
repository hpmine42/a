<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { Pt, Quad } from "../lib/cv";
import { bitmapToImageData, cropRegion, imageDataFromFile } from "../lib/image";
import {
  installedRelatedApps,
  isStaleInstall,
  isStandaloneDisplay,
  promptInstall,
  shouldOfferInstall,
  watchInstallPrompt,
} from "../lib/install";
import { tap, thump } from "../lib/haptics";
import { IMPORT_MAX } from "../lib/store";

const props = defineProps<{ thumbs: string[]; pageCount: number }>();
const emit = defineEmits<{
  (e: "captured", payload: { img: ImageData; quad: Quad | null; auto: boolean }): void;
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

const zoomLabel = computed(() => `${(usingUltra.value ? 0.5 : zoom.value * softZoom.value).toFixed(1)}×`);
const showZoomRow = computed(() => ready.value);

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

/* ------------------------------------------------------------------ camera */

async function startStream(mode: "environment" | "user", deviceId?: string) {
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

  const track = stream.getVideoTracks()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
  torchAvailable.value = Boolean(caps.torch);
  torchOn.value = false;

  const z = zoomCapability(track);
  zoomCaps.value = z ? { min: z.min ?? 1, max: z.max ?? 1, step: z.step ?? 0.1 } : null;
  zoom.value = 1;
  softZoom.value = 1;
  void findUltraWide();
}

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ready.value = false;
}

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

function distance() {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onPointerDown(event: PointerEvent) {
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
      return;
    }
    const scale = v.videoWidth / small.width;
    target.value = quad.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad;
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

function draw() {
  const canvas = overlay.value;
  const v = video.value;
  if (!canvas || !v) return;
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

function loop(now: number) {
  if (disposed) return;
  scheduleDetection(now);
  draw();
  raf = requestAnimationFrame(loop);
}

/* ----------------------------------------------------------------- capture */

async function capture() {
  const v = video.value;
  if (!v || !v.videoWidth) return;
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
    emit("captured", { img: cropped, quad, auto: autoOn.value });
  } catch (err) {
    console.error("[scanner] capture failed", err);
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
    emit("captured", { img, quad: null, auto: false });
  } catch (err) {
    console.error("[scanner] demo photo unavailable", err);
  } finally {
    loading.value = false;
  }
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith("image/"));
  input.value = "";
  if (!files.length) return;
  tap();
  loading.value = true;
  try {
    for (const file of files) {
      emit("captured", { img: await imageDataFromFile(file, IMPORT_MAX), quad: null, auto: false });
    }
  } catch (err) {
    console.error("[scanner] could not read the photo", err);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------------ mount */

let observer: ResizeObserver | null = null;

onMounted(async () => {
  ensureWorker();
  autoOn.value = rememberedDetect();
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
  await startStream(facing.value);
  raf = requestAnimationFrame(loop);
  observer = new ResizeObserver(() => draw());
  if (stage.value) observer.observe(stage.value);
});

onBeforeUnmount(() => {
  disposed = true;
  unwatchInstall?.();
  window.removeEventListener("focus", detectInstallState);
  cancelAnimationFrame(raf);
  observer?.disconnect();
  worker?.terminate();
  worker = null;
  stopStream();
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
        <span class="zoom-value" aria-live="polite">{{ zoomLabel }}</span>
      </div>

      <Transition name="fade">
        <div v-if="loading" class="camera-busy" role="status" aria-live="polite">
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
      <template v-if="autoOn && target">Page found — it will be used</template>
      <template v-else-if="autoOn">Looking for the page…</template>
      <template v-else>Point at a page and tap the shutter · pinch to zoom</template>
    </p>

    <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFiles" />
  </div>
</template>
