<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { canvasFor } from "../lib/image";
import { containFit } from "../lib/geometry";

const props = defineProps<{
  src: ImageData;
  pageCount: number;
  /** Was live detection switched on when this photo was taken? */
  detectionOn: boolean;
  /** A detection pass is running; the sheet must not move under the finger. */
  busy?: boolean;
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
  const fit = containFit(props.src.width, props.src.height, rect.width - pad * 2, rect.height - pad * 2);
  ctx.drawImage(
    canvasFor(props.src),
    fit.dx + pad,
    fit.dy + pad,
    props.src.width * fit.scale,
    props.src.height * fit.scale
  );
}

onMounted(() => {
  observer = new ResizeObserver(draw);
  if (host.value) observer.observe(host.value);
  draw();
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
      <!--
        Two different situations, two different sentences. "No page detected"
        is only true when detection actually ran; with the toggle off the user
        was never looking for an outline, so asking "how should we crop?" is
        the honest question.
      -->
      <p class="review-title">
        <strong>{{ props.detectionOn ? "No page edge found" : "How should we crop this?" }}</strong>
        <span>
          {{ props.detectionOn
            ? "Nothing to snap to — pick a crop and straighten it yourself."
            : "Detection is off, so nothing was cropped. Pick one option:" }}
        </span>
      </p>

      <button class="choice primary" :disabled="props.busy" @click="emit('auto')">
        <span class="choice-icon">
          <span v-if="props.busy" class="spinner" />
          <Icon v-else name="auto" :size="22" />
        </span>
        <span class="choice-text">
          <strong>{{ props.busy ? "Looking for the page…" : "Find the page automatically" }}</strong>
          <small>{{ props.busy ? "One pass over the photo" : "Scan this photo once for a paper edge" }}</small>
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
    </div>
  </div>
</template>
