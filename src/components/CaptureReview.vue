<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { Quad } from "../lib/cv";
import { prefersReducedMotion, SWEEP_MS } from "../lib/anim";
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
  /** A second sheet in the same photo, when there is one. */
  extra?: Quad | null;
  /** Photos picked together that are still waiting behind this one. */
  queued?: number;
}>();

const emit = defineEmits<{
  (e: "auto"): void;
  (e: "manual"): void;
  (e: "whole"): void;
  (e: "retake"): void;
  (e: "both"): void;
  (e: "single"): void;
  /** "Use this crop": the search found a page and the user agreed with it. */
  (e: "confirm"): void;
  /** "Crop it myself": the search found a page, the user wants the corners. */
  (e: "adjust"): void;
  /** The amber band has run from the top of the photo to the bottom. */
  (e: "swept"): void;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const host = ref<HTMLDivElement | null>(null);
let observer: ResizeObserver | null = null;
let raf = 0;
/** Clock for the current animation: the sweep cycles, the reveal runs once. */
let phaseStart = 0;
/** The sweep animation has finished for the current search. */
let sweepAnnounced = false;

const title = computed(() => {
  if (props.phase === "searching") return "Looking for the page…";
  if (props.phase === "found") return props.extra ? "Two pages found" : "Page found";
  if (props.phase === "miss") return "No page edge found";
  if (props.origin === "upload") return "How should we crop this?";
  return props.detectionOn ? "No page edge found" : "How should we crop this?";
});

const subtitle = computed(() => {
  if (props.phase === "searching") return "One quick pass over the photo.";
  // Three buttons, three answers — the line is the menu, not a slogan.
  if (props.phase === "found")
    return props.extra ? "Both pages, just the first, or your own corners:" : "Straightening it now.";
  if (props.phase === "miss") return "Nothing to snap to — drag the corners yourself.";
  // A photo from the library was never a viewfinder: there was no detection to
  // be “off”, so do not blame a switch the user never touched.
  if (props.origin === "upload") return "Nothing has been cropped yet. Pick one option:";
  return props.detectionOn
    ? "Nothing to snap to — pick a crop and straighten it yourself."
    : "Detection is off, so nothing was cropped. Pick one option:";
});

/** Two sheets: the sheet stays up and asks which, because this one *is* a question. */
const asking = computed(() => props.phase === "found" && Boolean(props.extra));
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
    /*
     * One pass, top to bottom, then done.
     *
     * This used to cycle and to stop wherever the detector happened to finish —
     * usually in the middle of the page — which made the scan look like it had
     * only covered half the photo. The band now always travels the whole page
     * once, and detection waits for it (see SWEEP_MS).
     */
    /*
     * The band starts above the photo and ends below it.
     *
     * It used to travel only 3%…97% and then fade, which on a short landscape
     * photo reads as "it stopped before the bottom edge". Now it enters and
     * exits: the clip on the photo crops it, so the pass is visibly complete.
     */
    const sweep = prefersReducedMotion()
      ? 1
      : Math.min(1, (performance.now() - phaseStart) / SWEEP_MS);
    const y = dy + dh * (-0.08 + sweep * 1.16);
    // the band belongs to the photo, not to the sheet around it
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
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
    ctx.restore();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
  }

  if (props.phase === "found" && props.extra) {
    const t = prefersReducedMotion() ? 1 : Math.min(1, (performance.now() - phaseStart) / 280);
    drawQuad(ctx, sx, props.extra, t, "rgba(255, 255, 255, 0.55)");
  }

  if (props.phase === "found" && props.found) {
    const t = prefersReducedMotion() ? 1 : Math.min(1, (performance.now() - phaseStart) / 280);
    drawQuad(ctx, sx, props.found, t, "#ffc061");
  }
}

/**
 * One found sheet: a soft wash, a hairline, and four amber brackets — the same
 * "locked on" language as the viewfinder, so the reveal needs no explaining.
 */
function drawQuad(
  ctx: CanvasRenderingContext2D,
  sx: (p: { x: number; y: number }) => { x: number; y: number },
  quad: Quad,
  t: number,
  bracketColor: string
): void {
  const grow = 1 + (1 - t) * 0.06;
  const pts = quad.map((p) => sx(p));
  const cx = pts.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = pts.reduce((sum, p) => sum + p.y, 0) / 4;
  const scaled = pts.map((p) => ({ x: cx + (p.x - cx) * grow, y: cy + (p.y - cy) * grow }));

  ctx.save();
  ctx.globalAlpha = 0.25 + 0.75 * t;
  ctx.beginPath();
  ctx.moveTo(scaled[0].x, scaled[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(scaled[i].x, scaled[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 192, 97, 0.1)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.stroke();

  const span = Math.hypot(scaled[1].x - scaled[0].x, scaled[1].y - scaled[0].y);
  const bracket = Math.min(34, Math.max(14, span * 0.16));
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.strokeStyle = bracketColor;
  for (let i = 0; i < 4; i++) {
    const p = scaled[i];
    const prev = scaled[(i + 3) % 4];
    const next = scaled[(i + 1) % 4];
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

/* -------------------------------------------------------------- animation */

function frame() {
  raf = 0;
  draw();
  if (props.phase === "searching") {
    // run until the band has left the photo, then stop — the detector no longer
    // decides how far the pass gets
    const done = prefersReducedMotion() || performance.now() - phaseStart >= SWEEP_MS;
    if (done) {
      announceSweep();
      return;
    }
    raf = requestAnimationFrame(frame);
    return;
  }
  if (props.phase === "found") {
    // the reveal runs once: 280ms of corners settling, then the last frame stays
    if (!prefersReducedMotion() && performance.now() - phaseStart < 260) {
      raf = requestAnimationFrame(frame);
    }
  }
}

function kick() {
  if (raf) return;
  raf = requestAnimationFrame(frame);
}

/** One "the band has left the photo" per search, so the reveal is timed by the
 *  animation itself and not by a sleep that can drift. */
function announceSweep() {
  if (sweepAnnounced) return;
  sweepAnnounced = true;
  emit("swept");
}

watch(
  () => props.phase,
  (phase) => {
    phaseStart = performance.now();
    sweepAnnounced = phase !== "searching";
    kick();
  }
);

watch(() => props.found, kick);

onMounted(() => {
  observer = new ResizeObserver(draw);
  if (host.value) observer.observe(host.value);
  draw();
  // The sheet can be mounted straight into a search (a second photo while the
  // first one is still going): the pass has to start here too, not only when the
  // phase *changes*.
  if (props.phase === "searching") {
    phaseStart = performance.now();
    sweepAnnounced = false;
    kick();
  }
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
      <span class="review-count">
        {{ props.pageCount > 0 ? `Page ${props.pageCount + 1}` : "First page" }}
        <!-- a batch import must say where the rest of it went -->
        <template v-if="props.queued"> · {{ props.queued }} more waiting</template>
      </span>
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

      <template v-if="props.phase === 'found' && props.found && !props.extra">
        <button class="choice primary reveal" @click="emit('confirm')">
          <span class="choice-icon"><Icon name="check" :size="22" /></span>
          <span class="choice-text">
            <strong>Use this crop</strong>
            <small>Straighten the page inside that outline</small>
          </span>
        </button>

        <button class="choice reveal" @click="emit('adjust')">
          <span class="choice-icon"><Icon name="crop" :size="22" /></span>
          <span class="choice-text">
            <strong>Crop it myself</strong>
            <small>Drag the four corners where you want them</small>
          </span>
        </button>
      </template>

      <template v-if="asking">
        <button class="choice primary" @click="emit('both')">
          <span class="choice-icon"><Icon name="image" :size="22" /></span>
          <span class="choice-text">
            <strong>Scan both pages</strong>
            <small>Two pages out of this one photo</small>
          </span>
        </button>

        <button class="choice" @click="emit('single')">
          <span class="choice-icon"><Icon name="crop" :size="22" /></span>
          <span class="choice-text">
            <strong>Just the first one</strong>
            <small>Straighten the page on the left</small>
          </span>
        </button>

        <!--
          Two sheets do not mean the outline is right, and they do not mean the
          user wants both. Without this third way out, a wrong detection on a
          photo of two pages left only "scan the pair" or "scan half of it" —
          the corners tool was somewhere else entirely.
        -->
        <button class="choice" @click="emit('adjust')">
          <span class="choice-icon"><Icon name="crop" :size="22" /></span>
          <span class="choice-text">
            <strong>Crop it myself</strong>
            <small>Start from the marked page, then drag its corners</small>
          </span>
        </button>
      </template>

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
