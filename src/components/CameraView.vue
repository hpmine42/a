<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { Pt, Quad } from "../lib/cv";
import { imageDataFromFile, bitmapToImageData } from "../lib/image";

const props = defineProps<{ thumbs: string[]; pageCount: number }>();
const emit = defineEmits<{
  (e: "captured", img: ImageData): void;
  (e: "open-pages"): void;
}>();

const stage = ref<HTMLDivElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
const overlay = ref<HTMLCanvasElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const error = ref<"denied" | "missing" | null>(null);
const ready = ref(false);
const autoOn = ref(true);
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

const target = ref<Quad | null>(null);
const eased = ref<Quad | null>(null);
const lastReqId = ref(0);

const hasThumbs = computed(() => props.thumbs.length > 0);

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
    /* autoplay can fail before the element is visible — the next frame retries */
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
  const scale = Math.min(1, 360 / Math.max(v.videoWidth, v.videoHeight));
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
  const small = grabSmall();
  if (!small) return;
  detecting = true;
  nextDetectAt = now + 380;
  const id = ++lastReqId.value;
  worker.postMessage(
    { id, width: small.width, height: small.height, buffer: small.data.data.buffer },
    [small.data.data.buffer]
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
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const map = coverRect();
  if (!map) return;

  eased.value = ease(eased.value, target.value, 0.22);
  const quad = eased.value;
  if (!quad || !autoOn.value) return;

  const pts = quad.map((p) => ({ x: p.x * map.scale + map.dx, y: p.y * map.scale + map.dy }));
  const inset = 0.5;

  // dim the surface around the sheet, very lightly: it frames without shouting
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, rect.width, rect.height);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(8, 9, 11, 0.34)";
  ctx.fill("evenodd");
  ctx.restore();

  // the sheet outline
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

  // amber corner brackets: the app's one accent, used for the "locked on" signal
  const bracket = Math.min(26, Math.max(14, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) * 0.18));
  ctx.strokeStyle = "#ffc061";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const prev = pts[(i + 3) % 4];
    const next = pts[(i + 1) % 4];
    const dirA = { x: (prev.x - p.x) / (Math.hypot(prev.x - p.x, prev.y - p.y) || 1), y: (prev.y - p.y) / (Math.hypot(prev.x - p.x, prev.y - p.y) || 1) };
    const dirB = { x: (next.x - p.x) / (Math.hypot(next.x - p.x, next.y - p.y) || 1), y: (next.y - p.y) / (Math.hypot(next.x - p.x, next.y - p.y) || 1) };
    ctx.beginPath();
    ctx.moveTo(p.x + dirA.x * bracket * inset, p.y + dirA.y * bracket);
    ctx.lineTo(p.x, p.y);
    ctx.lineTo(p.x + dirB.x * bracket, p.y + dirB.y * bracket);
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
    emit("captured", img);
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
    emit("captured", await imageDataFromFile(file, 2600));
  } catch (err) {
    console.error("[flatbed] demo photo unavailable", err);
  }
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith("image/"));
  input.value = "";
  for (const file of files) {
    emit("captured", await imageDataFromFile(file, 2600));
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
  if (!on) target.value = null;
});
</script>

<template>
  <div class="camera">
    <div class="camera-stage" ref="stage">
      <video ref="video" class="camera-video" playsinline muted autoplay />
      <canvas ref="overlay" class="camera-overlay" />
      <div class="vignette" aria-hidden="true" />

      <div class="camera-top">
        <div class="brand" aria-label="flatbed">
          <span class="brand-mark" />
        </div>
        <div v-if="ready" class="camera-top-right">
          <button
            class="round"
            :class="{ on: autoOn }"
            :aria-pressed="autoOn"
            aria-label="Automatic page detection"
            @click="autoOn = !autoOn"
          >
            <Icon name="auto" :size="20" />
          </button>
          <button
            v-if="torchAvailable"
            class="round"
            :class="{ on: torchOn }"
            :aria-pressed="torchOn"
            aria-label="Torch"
            @click="toggleTorch"
          >
            <Icon :name="torchOn ? 'flash' : 'flash-off'" :size="20" />
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
          <button class="pill" @click="fileInput?.click()">Choose photo</button>
          <button class="pill ghost" @click="useDemo">Demo photo</button>
        </div>
      </div>

      <Transition name="fade">
        <div v-if="flash" class="shutter-flash" />
      </Transition>
    </div>

    <div class="camera-dock">
      <button class="dock-slot" @click="fileInput?.click()" aria-label="Choose a photo">
        <span class="round"><Icon name="gallery" :size="21" /></span>
      </button>

      <button class="shutter" :disabled="!ready" aria-label="Take photo" @click="capture">
        <span class="shutter-ring" />
      </button>

      <button class="dock-slot" @click="flipCamera" aria-label="Flip camera">
        <span class="round"><Icon name="flip" :size="21" /></span>
      </button>

      <button
        v-if="hasThumbs"
        class="stack"
        @click="emit('open-pages')"
        :aria-label="`Open ${pageCount} scanned pages`"
      >
        <img :src="thumbs[thumbs.length - 1]" alt="" />
        <span class="stack-badge">{{ pageCount }}</span>
      </button>
    </div>

    <p class="camera-hint">
      <span class="live-dot" :class="{ on: autoOn && !!target }" aria-hidden="true" />
      {{ autoOn ? "Frame the page" : "Detection off" }}
    </p>

    <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onFiles" />
  </div>
</template>
