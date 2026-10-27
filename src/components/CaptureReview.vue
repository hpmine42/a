<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { Quad } from "../lib/cv";
import { prefersReducedMotion } from "../lib/anim";
import { canvasFor } from "../lib/image";
import { containFit } from "../lib/geometry";

export type ReviewPhase = "idle" | "searching" | "found" | "miss";

const props = defineProps<{
  src: ImageData;
  pageCount: number;
  /** Where the photo came from — the words differ, the work does not. */
  origin?: "camera" | "upload";
  /** Was live detection switched on when this photo was taken? */
  detectionOn: boolean;
  /** A detection pass is running; the sheet must not move under the finger. */
  busy?: boolean;
  /** What the automatic search is doing right now. */
  phase?: ReviewPhase;
  /** The sheet the search found, in source pixels, for the reveal animation. */
  found?: Quad | null;
}>();

const emit = defineEmits<{
  (e: "auto"): void;
  (e: "manual"): void;
  (e: "whole"): void;
  (e: "retake"): void;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const host = ref<HTMLDivElement | null>(null);
let observer: ResizeObserver | null = null;
let raf = 0;
/** 0..1 over the reveal, or -1 when there is nothing to animate. */
let reveal = -1;
let sweep = 0;

const title = computed(() => {
  if (props.phase === "searching") return "Looking for the page…";
  if (props.phase === "found") return "Page found";
  if (props.phase === "miss") return "No page edge found";
  if (props.origin === "upload") return "How should we crop this?";
  return props.detectionOn ? "No page edge found" : "How should we crop this?";
});

const subtitle = computed(() => {
  if (props.phase === "searching") return "One quick pass over the photo.";
  if (props.phase === "found") return "Straightening it now.";
  if (props.phase === "miss") return "Nothing to snap to — drag the corners yourself.";
  // A photo from the library was never a viewfinder: there was no detection to
  // be “off”, so do not blame a switch the user never touched.
  if (props.origin === "upload") return "Nothing has been cropped yet. Pick one option:";
  return props.detectionOn
    ? "Nothing to snap to — pick a crop and straighten it yourself."
    : "Detection is off, so nothing was cropped. Pick one option:";
});

const showChoices = computed(() => props.phase !== "searching" && props.phase !== "found");

function fitFor(w: number, h: number) {
  const pad = 12;
  return containFit(props.src.width, props.src.height, w - pad * 2, h - pad * 2);
}

function draw() {
  const el = canvas.value;
  const box = host.value;
  if (!el || !box) return;
  const rect = box.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  if (el.width !== Math.round(rect.width * dpr) || el.height !== Math.round(rect.height * dpr)) {
    el.width = Math.round(rect.width * dpr);
    el.height = Math.round(rect.height * dpr);
  }
  const ctx = el.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.imageSmoothingQuality = "high";

  const pad = 12;
  const fit = fitFor(rect.width, rect.height);
  const dx = fit.dx + pad;
  const dy = fit.dy + pad;
  const dw = props.src.width * fit.scale;
  const dh = props.src.height * fit.scale;
  ctx.drawImage(canvasFor(props.src), dx, dy, dw, dh);

  const sx = (p: { x: number; y: number }) => ({ x: dx + p.x * fit.scale, y: dy + p.y * fit.scale });

  if (props.phase === "searching") {
    // a single bright band travelling down the photo: the honest picture of
    // "one pass over the photo", and it finishes when the pass does
    const y = dy + dh * (0.04 + sweep * 0.92);
    const band = ctx.createLinearGradient(0, y - 60, 0, y + 60);
    band.addColorStop(0, "rgba(255, 192, 97, 0)");
    band.addColorStop(0.5, "rgba(255, 192, 97, 0.3)");
    band.addColorStop(1, "rgba(255, 192, 97, 0)");
    ctx.fillStyle = band;
    ctx.fillRect(dx, y - 60, dw, 120);
    ctx.beginPath();
    ctx.moveTo(dx, y);
    ctx.lineTo(dx + dw, y);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 214, 152, 0.95)";
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
  }

  if (props.phase === "found" && props.found) {
    const t = reveal < 0 ? 1 : reveal;
    const grow = 1 + (1 - t) * 0.06;
    const cx = dx + dw / 2;
    const cy = dy + dh / 2;
    const pts = props.found.map((p) => {
      const q = sx(p);
      return { x: cx + (q.x - cx) * grow, y: cy + (q.y - cy) * grow };
    });
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.75 * t;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 192, 97, 0.1)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.stroke();

    // corner brackets, like the viewfinder's "locked on" language
    const bracket = Math.min(34, Math.max(16, Math.min(dw, dh) * 0.09));
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#ffc061";
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      const prev = pts[(i + 3) % 4];
      const next = pts[(i + 1) % 4];
      const unit = (q: { x: number; y: number }) => {
        const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        return { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
      };
      const a = unit(prev);
      const b = unit(next);
      ctx.beginPath();
      ctx.moveTo(p.x + a.x * bracket, p.y + a.y * bracket);
      ctx.lineTo(p.x, p.y);
      ctx.lineTo(p.x + b.x * bracket, p.y + b.y * bracket);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* -------------------------------------------------------------- animation */

function frame() {
  raf = 0;
  draw();
  const live = props.phase === "searching" || reveal >= 0;
  if (!live) return;

  if (props.phase === "searching") sweep = (sweep + 0.055) % 1;
  if (reveal >= 0) {
    reveal = Math.min(1, reveal + 0.14);
    if (reveal >= 1) {
      reveal = 1;
      return; // the last frame is already drawn and there is nothing left to do
    }
  }
  raf = requestAnimationFrame(frame);
}

function kick() {
  if (raf) return;
  raf = requestAnimationFrame(frame);
}

watch(
  () => props.phase,
  (phase) => {
    if (phase === "searching") {
      sweep = 0;
      reveal = -1;
    } else if (phase === "found") {
      reveal = prefersReducedMotion() ? -1 : 0;
    } else {
      reveal = -1;
    }
    kick();
  }
);

watch(() => props.found, kick);

onMounted(() => {
  observer = new ResizeObserver(draw);
  if (host.value) observer.observe(host.value);
  draw();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (raf) cancelAnimationFrame(raf);
});

watch(() => props.src, draw);
</script>

<template>
  <div class="review">
    <header class="review-top">
      <button class="control" aria-label="Discard photo and go back" @click="emit('retake')">
        <Icon name="close" :size="19" />
        <span>Discard</span>
      </button>
      <span class="review-count">{{ props.pageCount > 0 ? `${props.pageCount} scanned` : "New scan" }}</span>
      <span class="review-spacer" />
    </header>

    <div class="review-stage" ref="host">
      <canvas ref="canvas" class="review-canvas" />
    </div>

    <div class="review-sheet">
      <p class="review-title" :class="{ live: props.phase === 'searching' }">
        <strong>{{ title }}</strong>
        <span>{{ subtitle }}</span>
      </p>

      <template v-if="showChoices">
        <button class="choice primary" :disabled="props.busy" @click="emit('auto')">
          <span class="choice-icon"><Icon name="auto" :size="22" /></span>
          <span class="choice-text">
            <strong>Find the page automatically</strong>
            <small>Scan this photo once for a paper edge</small>
          </span>
        </button>

        <button class="choice" :disabled="props.busy" @click="emit('manual')">
          <span class="choice-icon"><Icon name="crop" :size="22" /></span>
          <span class="choice-text">
            <strong>Crop it by hand</strong>
            <small>Place the four corners yourself</small>
          </span>
        </button>

        <button class="choice" :disabled="props.busy" @click="emit('whole')">
          <span class="choice-icon"><Icon name="image" :size="22" /></span>
          <span class="choice-text">
            <strong>Keep the whole photo</strong>
            <small>No crop, no straightening</small>
          </span>
        </button>
      </template>
    </div>
  </div>
</template>
