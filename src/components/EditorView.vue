<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import CornerEditor from "./CornerEditor.vue";
import Icon from "./Icon.vue";
import type { Quad } from "../lib/cv";
import { glideQuad, sleep } from "../lib/anim";
import { click, tap } from "../lib/haptics";
import { canvasFor, containFit } from "../lib/image";
import { insetQuad, outputSize } from "../lib/cv";
import {
  activePage,
  autoDetect,
  EDGE_INSET,
  naturalSide,
  PREVIEW_MAX,
  processPage,
  scan,
} from "../lib/store";

const props = withDefaults(
  defineProps<{
    initialMode?: "result" | "frame";
    notice?: string | null;
    /** Where the back chip leads, so its label tells the truth. */
    backTo?: "camera" | "pages";
  }>(),
  { initialMode: "result", notice: null, backTo: "camera" }
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
const STAGE_PAD = 26;

const page = computed(() => activePage());
const mode = ref<"result" | "frame">(props.initialMode);
const notice = ref<string | null>(props.notice);
let noticeTimer = 0;
const busy = ref(false);
let busyTimer = 0;
/** "Find the page" is running: the crop canvas shows a sweep of its own. */
const searching = ref(false);
/** A failed search: the frame gives one small shake, then forgets it. */
const missed = ref(false);
let missTimer = 0;
/** The canvas just changed under the user: a 200ms dip says "this is new". */
const swapping = ref(false);
let swapTimer = 0;
const stage = ref<HTMLDivElement | null>(null);
const resultCanvas = ref<HTMLCanvasElement | null>(null);
const pageIndex = computed(() => scan.pages.findIndex((p) => p.id === scan.activeId) + 1);
const optimizing = computed(() => page.value?.opts.optimize ?? false);

let observer: ResizeObserver | null = null;
let drawFrame = 0;
let resizeTimer = 0;
/** Long side of the render the canvas is showing right now. */
let renderedSide = 0;
/** The crop changed but has not been rendered yet. */
let cropDirty = false;
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
  const pad = STAGE_PAD;
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
 * This has to be measured the way the canvas is measured: the page is fitted
 * into the stage *by its own aspect*, so on a portrait phone a portrait sheet is
 * limited by the screen width, not by its height. Sizing it by the stage's long
 * side (as this used to) rendered a 1000px-tall page and then squeezed it into
 * a 600px-tall canvas — and downscaling hard-thresholded text is precisely what
 * turns crisp black type into grey, uneven mush. Rendered at the canvas' own
 * pixel count, every glyph lands on the screen 1:1.
 */
function neededSide(): number {
  const host = stage.value;
  const current = page.value;
  if (!host) return PREVIEW_MAX;
  const rect = host.getBoundingClientRect();
  if (!rect.width || !rect.height) return PREVIEW_MAX;

  const page0 = current
    ? outputSize(insetQuad(current.quad, EDGE_INSET), 10000)
    : { w: 3, h: 4 };
  const boxW = Math.max(40, rect.width - STAGE_PAD);
  const boxH = Math.max(40, rect.height - STAGE_PAD);
  const cssLong = Math.max(page0.w, page0.h) * Math.min(boxW / page0.w, boxH / page0.h);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const natural = current ? naturalSide(current) : PREVIEW_MAX;
  /* Thresholded text is pure black and white, and a canvas that has to shrink
   * it lands each glyph edge on a different fraction of a pixel: solid strokes
   * break up, counters fill in, and the whole page reads blurry. Rendering a
   * third again larger than the canvas then lets the browser average *many*
   * pixels per output pixel, which is what makes small type look printed
   * instead of smeared. Never past the page's own resolution — upscaling
   * invents nothing. */
  const wanted = cssLong * dpr * 1.35;
  // A small import may be upsampled a little (that is what smooths the glyph
  // edges), but never far: past ~1.6x there is nothing left to interpolate.
  return Math.round(Math.min(PREVIEW_MAX, natural * 1.6, Math.max(700, wanted)));
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
  swapping.value = true;
  window.clearTimeout(swapTimer);
  swapTimer = window.setTimeout(() => (swapping.value = false), 220);
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
    // leaving the crop tool: this is the one pass that has to be on screen
    void reprocess({ rewriteWarp: true })
      .then(() => (cropDirty = false))
      .catch(() => undefined);
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
  cropDirty = true;
}

/**
 * Catching up after the crop tool: the grid, the filmstrip and the export all
 * read the page, not this component, so leaving mid-crop must not leave a stale
 * thumbnail behind. Rendered small and in the background — the user has already
 * moved on.
 */
function refreshQuietly() {
  const current = page.value;
  if (!current || !cropDirty) return;
  cropDirty = false;
  void processPage(current, { full: true, rewriteWarp: true, maxSide: neededSide() })
    .then(queueDraw)
    .catch(() => undefined);
}

async function finish() {
  tap();
  const current = page.value;
  // A crop that was never rendered would leave the grid showing the old page.
  // Rendering it small is a few dozen milliseconds and is worth the honesty.
  if (current && cropDirty) {
    cropDirty = false;
    await processPage(current, { full: true, rewriteWarp: true, maxSide: 900 }).catch(
      () => undefined
    );
  }
  emit("done");
}

function onCommit() {
  /* intentionally empty: see onQuad */
}

/**
 * "Find the page" inside the crop tool.
 *
 * The detector needs ~200ms, which is long enough to look frozen, so the canvas
 * sweeps while it runs. A hit then glides the four corners to the new page over
 * a fifth of a second — that is the whole point: you *see* what it picked. A
 * miss shakes the frame once and says so in words; no second animation.
 */
async function runAuto() {
  const current = page.value;
  if (!current || searching.value) return;
  const before = current.quad.map((p) => ({ ...p })) as Quad;
  tap();
  searching.value = true;
  await sleep(140);

  const found = autoDetect(current);
  searching.value = false;

  if (found) {
    const target = current.quad.map((p) => ({ ...p })) as Quad;
    current.quad = before;
    await glideQuad(before, target, 260, (quad) => {
      current.quad = quad as Quad;
      current.warped = null;
      current.warpedSide = 0;
      current.cacheKey = "";
      cropDirty = true;
    });
    current.quad = target;
    // no need to render here: the page is drawn when the crop tool closes, and
    // the sweep + glide have already shown what was found
    notice.value = "Page found — drag a corner to adjust";
  } else {
    missed.value = true;
    window.clearTimeout(missTimer);
    missTimer = window.setTimeout(() => (missed.value = false), 420);
    notice.value = "No page edge found — drag the corners";
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

/** The stage has no size until it is laid out; rendering before that would
 *  choose the biggest budget and throw it away a frame later. */
async function stageReady(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const rect = stage.value?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) return;
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

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
  await stageReady();
  const current = page.value;
  const want = neededSide();
  // an existing render at *or above* what the screen needs is good enough: a
  // 1400px preview on a 1250px canvas is not worth re-warping
  if (current && (!current.result || current.warpedSide < want)) {
    await reprocess({ rewriteWarp: !current.warped, maxSide: want });
  } else {
    renderedSide = current?.warpedSide ?? 0;
    queueDraw();
  }
  if (props.notice) {
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => (notice.value = null), 4200);
  }
});

onBeforeUnmount(() => {
  window.clearTimeout(swapTimer);
  window.clearTimeout(missTimer);
  refreshQuietly();
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
      <button
        class="control"
        :aria-label="props.backTo === 'pages' ? 'Back to pages' : 'Back to camera'"
        @click="emit('back')"
      >
        <Icon name="back" :size="19" />
        <span>Back</span>
      </button>

      <div
        class="editor-count"
        aria-live="polite"
        :aria-label="`Page ${pageIndex} of ${scan.pages.length}`"
      >
        {{ pageIndex }}<span>/{{ scan.pages.length }}</span>
      </div>

      <button
        v-if="mode === 'result'"
        class="control"
        aria-label="Adjust the corners"
        @click="toggleFrame"
      >
        <Icon name="crop" :size="19" />
        <span>Crop</span>
      </button>
      <!-- in the crop tool the way out is the big button below, not here -->
      <span v-else class="editor-spacer" aria-hidden="true" />
    </header>

    <div class="editor-stage" ref="stage">
      <canvas
        v-show="mode === 'result'"
        ref="resultCanvas"
        class="paper-canvas"
        :class="{ swapping }"
      />

      <CornerEditor
        v-if="mode === 'frame'"
        :src="page.src"
        :quad="page.quad"
        :searching="searching"
        :class="{ missed }"
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

    <footer class="editor-dock" :class="{ cropping: mode === 'frame' }">
      <button
        v-if="mode === 'frame'"
        class="crop-done"
        aria-label="Done cropping"
        @click="toggleFrame"
      >
        <Icon name="check" :size="20" :stroke="2.4" />
        <span>Done cropping</span>
      </button>

      <template v-else>
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
            <small>{{ optimizing ? "On · crisp text" : "Off · untouched" }}</small>
          </span>
          <span class="optimize-switch" aria-hidden="true"><span /></span>
        </button>

        <button class="done" aria-label="Done with this page" @click="finish">
          <Icon name="check" :size="20" :stroke="2.4" />
          <span>Done</span>
        </button>
      </template>
    </footer>
  </div>
</template>
