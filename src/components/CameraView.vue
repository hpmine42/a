<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { Pt, Quad } from "../lib/cv";
import { bitmapToImageData, imageDataFromFile } from "../lib/image";

const props = defineProps<{ thumbs: string[]; pageCount: number }>();
const emit = defineEmits<{
  (e: "captured", payload: { img: ImageData; quad: Quad | null }): void;
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
const torchOn = ref(false);
const torchAvailable = ref(false);
const facing = ref<"environment" | "user">("environment");
const flash = ref(false);

let stream: MediaStream | null = null;
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

async function startStream(mode: "environment" | "user") {
  stopStream();
  error.value = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
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
}

function stopStream() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ready.value = false;
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
  target.value = null;
  eased.value = null;
  await startStream(facing.value);
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
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = Math.max(rect.width / v.videoWidth, rect.height / v.videoHeight);
  return {
    scale,
    dx: (rect.width - v.videoWidth * scale) / 2,
    dy: (rect.height - v.videoHeight * scale) / 2,
    w: rect.width,
    h: rect.height,
  };
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
  const rect = canvas.getBoundingClientRect();
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
  flash.value = true;
  window.setTimeout(() => (flash.value = false), 220);
  try {
    const img = bitmapToImageData(v, 2600);
    // A visible outline means the sheet was already found: use it, do not ask.
    const live = autoOn.value ? target.value : null;
    let quad: Quad | null = null;
    if (live) {
      const scale = img.width / v.videoWidth;
      quad = live.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad;
    }
    emit("captured", { img, quad });
  } catch (err) {
    console.error("[flatbed] capture failed", err);
  }
}

async function useDemo() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/letter.jpg`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], "demo-invoice.jpg", { type: blob.type || "image/jpeg" });
    const img = await imageDataFromFile(file, 2600);
    // the demo photo has no live viewfinder, so let the detector decide
    emit("captured", { img, quad: null });
  } catch (err) {
    console.error("[flatbed] demo photo unavailable", err);
  }
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith("image/"));
  input.value = "";
  for (const file of files) {
    emit("captured", { img: await imageDataFromFile(file, 2600), quad: null });
  }
}

/* ------------------------------------------------------------------ mount */

let observer: ResizeObserver | null = null;

onMounted(async () => {
  ensureWorker();
  await startStream(facing.value);
  raf = requestAnimationFrame(loop);
  observer = new ResizeObserver(() => draw());
  if (stage.value) observer.observe(stage.value);
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(raf);
  observer?.disconnect();
  worker?.terminate();
  worker = null;
  stopStream();
});

watch(autoOn, (on) => {
  if (!on) {
    target.value = null;
    eased.value = null;
  }
});
</script>

<template>
  <div class="camera">
    <div class="camera-stage" ref="stage">
      <video ref="video" class="camera-video" playsinline muted autoplay />
      <canvas ref="overlay" class="camera-overlay" />
      <div class="vignette" aria-hidden="true" />

      <div class="camera-top">
        <div class="brand" aria-label="flatbed"><span class="brand-mark" /></div>

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

      <button class="dock-action" @click="flipCamera" aria-label="Switch camera">
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

    <p class="camera-hint">
      <span class="live-dot" :class="{ on: autoOn && !!target }" aria-hidden="true" />
      <template v-if="autoOn && target">Page found — it will be used</template>
      <template v-else-if="autoOn">Looking for the page…</template>
      <template v-else>Point at a page and tap the shutter</template>
    </p>

    <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFiles" />
  </div>
</template>
