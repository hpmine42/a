<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import CornerEditor from "./CornerEditor.vue";
import Icon from "./Icon.vue";
import type { Quad } from "../lib/cv";
import { click, tap } from "../lib/haptics";
import { canvasFor, containFit } from "../lib/image";
import { activePage, autoDetect, CROP_MAX, PREVIEW_MAX, processPage, scan } from "../lib/store";

const props = withDefaults(
  defineProps<{ initialMode?: "result" | "frame"; notice?: string | null }>(),
  { initialMode: "result", notice: null }
);

const emit = defineEmits<{ (e: "back"): void; (e: "done"): void }>();

/**
 * A pass under ~150ms should not flash a spinner at the user: the spinner is
 * for a real wait, not for a flicker.
 */
function showBusy() {
  window.clearTimeout(busyTimer);
  if (busy.value) return;
  busyTimer = window.setTimeout(() => (busy.value = true), 130);
}

function hideBusy() {
  window.clearTimeout(busyTimer);
  busy.value = false;
}

/** Breathing room around the page, in CSS pixels — must match .editor-stage. */
const STAGE_PAD = 40;

const page = computed(() => activePage());
const mode = ref<"result" | "frame">(props.initialMode);
const notice = ref<string | null>(props.notice);
let noticeTimer = 0;
const busy = ref(false);
let busyTimer = 0;
const stage = ref<HTMLDivElement | null>(null);
const resultCanvas = ref<HTMLCanvasElement | null>(null);
const pageIndex = computed(() => scan.pages.findIndex((p) => p.id === scan.activeId) + 1);
const optimizing = computed(() => page.value?.opts.optimize ?? true);

let observer: ResizeObserver | null = null;
let drawFrame = 0;
let resizeTimer = 0;
/** Long side of the render the canvas is showing right now. */
let renderedSide = 0;
/** Bumped per reprocess so a slower, older pass cannot overwrite a newer one. */
let generation = 0;

/* -------------------------------------------------------------- result view */

function drawResult() {
  const el = resultCanvas.value;
  const host = stage.value;
  const current = page.value;
  if (!el || !host || !current?.result) return;
  const img = current.result;
  const rect = host.getBoundingClientRect();
  const pad = 26;
  if (!rect.width || !rect.height) return;

  const fit = containFit(
    img.width,
    img.height,
    Math.max(40, rect.width - pad),
    Math.max(40, rect.height - pad)
  );
  const cssW = Math.max(1, Math.round(img.width * fit.scale));
  const cssH = Math.max(1, Math.round(img.height * fit.scale));
  // 2x is plenty for a page that is never wider than the screen; 3x triples
  // the canvas memory for a difference nobody can see
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  el.style.width = `${cssW}px`;
  el.style.height = `${cssH}px`;
  if (el.width !== Math.round(cssW * dpr) || el.height !== Math.round(cssH * dpr)) {
    el.width = Math.round(cssW * dpr);
    el.height = Math.round(cssH * dpr);
  }
  const ctx = el.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvasFor(img), 0, 0, cssW, cssH);
}

function queueDraw() {
  if (drawFrame) return;
  drawFrame = requestAnimationFrame(() => {
    drawFrame = 0;
    if (mode.value === "result") drawResult();
  });
}

/**
 * How many pixels the page actually needs.
 *
 * The editor never zooms, so rendering at 2400px to show a 380px-wide page was
 * nine times the work for a difference no one can see — and it made the
 * Optimize switch feel sluggish. Render at the size of the glass instead, with
 * a little headroom for odd pixel ratios. Exports re-render at full size anyway.
 */
function neededSide(): number {
  const host = stage.value;
  if (!host) return PREVIEW_MAX;
  const rect = host.getBoundingClientRect();
  if (!rect.width || !rect.height) return PREVIEW_MAX;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const long = Math.max(28, Math.max(rect.width, rect.height) - STAGE_PAD);
  return Math.round(Math.min(PREVIEW_MAX, Math.max(720, long * dpr * 1.04)));
}

/**
 * One reprocess at a time. `busy` is what the little spinner shows, and the
 * generation counter makes sure a fast toggle back does not end up displaying
 * the slower pass that started earlier.
 */
async function reprocess(options: { rewriteWarp?: boolean; maxSide?: number; full?: boolean } = {}) {
  const current = page.value;
  if (!current) return;
  const mine = ++generation;
  showBusy();
  try {
    const maxSide = options.maxSide ?? neededSide();
    await processPage(current, {
      full: options.full ?? true,
      rewriteWarp: options.rewriteWarp,
      maxSide,
    });
    if (mine !== generation) return;
    renderedSide = maxSide;
    await nextTick();
    queueDraw();
  } finally {
    if (mine === generation) hideBusy();
  }
}

async function setOptimize(next: boolean) {
  const current = page.value;
  if (!current || current.opts.optimize === next) return;
  click();
  current.opts.optimize = next;
  await reprocess({});
}

async function toggleOptimize() {
  await setOptimize(!optimizing.value);
}

function toggleFrame() {
  tap();
  mode.value = mode.value === "result" ? "frame" : "result";
  if (mode.value === "frame") {
    // the corner tool works on the photo; nothing to render yet
    notice.value = null;
  } else {
    // leaving the crop tool: this is the one pass that has to be at full preview
    void reprocess({ rewriteWarp: true });
  }
}

/**
 * Dragging a corner must not cost a warp per finger lift. The result canvas is
 * hidden while the frame tool is open, so the work is deferred until the user
 * leaves the tool — one pass instead of one per gesture.
 */
function onQuad(next: Quad) {
  const current = page.value;
  if (!current) return;
  current.quad = next;
  current.warped = null;
  current.warpedSide = 0;
  current.cacheKey = "";
}

function onCommit() {
  /* intentionally empty: see onQuad */
}

async function runAuto() {
  const current = page.value;
  if (!current) return;
  showBusy();
  try {
    const found = autoDetect(current);
    if (found) {
      await reprocess({ rewriteWarp: true, maxSide: CROP_MAX, full: false });
      mode.value = "frame";
      notice.value = "Page found — drag a corner to adjust";
    } else {
      notice.value = "No page edge found — drag the corners";
    }
  } finally {
    hideBusy();
  }
}

watch(
  () => page.value?.result,
  () => queueDraw()
);

watch(
  () => props.notice,
  (next) => {
    notice.value = next;
    if (!next) return;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => (notice.value = null), 4200);
  }
);

watch(
  () => page.value?.id,
  async () => {
    mode.value = "result";
    if (!page.value?.result) await reprocess({ rewriteWarp: true });
    else await nextTick(queueDraw);
  }
);

onMounted(async () => {
  observer = new ResizeObserver(() => {
    queueDraw();
    // a real resize (rotation, desktop window) can change how many pixels the
    // page deserves; re-render once the user has stopped dragging
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const want = neededSide();
      if (renderedSide && Math.abs(want - renderedSide) / renderedSide > 0.18) {
        void reprocess({ full: false });
      }
    }, 260);
  });
  if (stage.value) observer.observe(stage.value);
  await nextTick();
  if (page.value && (!page.value.result || page.value.warpedSide !== neededSide())) {
    await reprocess({ rewriteWarp: true });
  } else {
    renderedSide = page.value?.warpedSide ?? 0;
    queueDraw();
  }
  if (props.notice) {
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => (notice.value = null), 4200);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  window.clearTimeout(resizeTimer);
  window.clearTimeout(busyTimer);
  if (drawFrame) cancelAnimationFrame(drawFrame);
  window.clearTimeout(noticeTimer);
});

defineExpose({ openFrame: () => (mode.value = "frame") });
</script>

<template>
  <div class="editor" v-if="page">
    <header class="editor-top">
      <button class="control" aria-label="Back to camera" @click="emit('back')">
        <Icon name="back" :size="19" />
        <span>Back</span>
      </button>

      <div class="editor-count" aria-live="polite">
        {{ pageIndex }}<span>/{{ scan.pages.length }}</span>
      </div>

      <button
        class="control"
        :class="{ on: mode === 'frame' }"
        :aria-pressed="mode === 'frame'"
        aria-label="Adjust the corners"
        @click="toggleFrame"
      >
        <Icon name="crop" :size="19" />
        <span>{{ mode === 'frame' ? 'Done cropping' : 'Crop' }}</span>
      </button>
    </header>

    <div class="editor-stage" ref="stage">
      <canvas v-show="mode === 'result'" ref="resultCanvas" class="paper-canvas" />

      <CornerEditor
        v-if="mode === 'frame'"
        :src="page.src"
        :quad="page.quad"
        @update:quad="onQuad"
        @commit="onCommit"
      />

      <p v-if="mode === 'frame'" class="frame-hint" role="status">
        {{ notice ?? "Drag a corner to adjust" }}
      </p>
      <p v-else-if="notice" class="frame-hint" role="status">{{ notice }}</p>

      <button v-if="mode === 'frame'" class="auto-pill" @click="runAuto">
        <Icon name="auto" :size="18" />
        <span>Find the page</span>
      </button>

      <Transition name="fade">
        <div v-if="busy" class="busy-chip">
          <span class="spinner" />
        </div>
      </Transition>
    </div>

    <footer class="editor-dock">
      <button
        class="optimize"
        :class="{ on: optimizing }"
        :aria-pressed="optimizing"
        aria-label="Optimize this page"
        @click="toggleOptimize"
      >
        <span class="optimize-icon" aria-hidden="true">
          <Icon name="sparkle" :size="20" :stroke="1.9" />
        </span>
        <span class="optimize-text">
          <strong>Optimize</strong>
          <small>{{ optimizing ? "On · crisp text, white paper" : "Off · photo as taken" }}</small>
        </span>
        <span class="optimize-switch" aria-hidden="true"><span /></span>
      </button>

      <button class="done" aria-label="Done with this page" @click="tap(); emit('done')">
        <Icon name="check" :size="20" :stroke="2.4" />
        <span>Done</span>
      </button>
    </footer>
  </div>
</template>
