<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import CornerEditor from "./CornerEditor.vue";
import Icon from "./Icon.vue";
import type { Mode, Quad } from "../lib/cv";
import { canvasFor, containFit } from "../lib/image";
import { activePage, autoDetect, processPage, scan } from "../lib/store";

const props = withDefaults(
  defineProps<{ initialMode?: "result" | "frame"; notice?: string | null }>(),
  { initialMode: "result", notice: null }
);

const emit = defineEmits<{ (e: "back"): void; (e: "done"): void }>();

const page = computed(() => activePage());
const mode = ref<"result" | "frame">(props.initialMode);
const notice = ref<string | null>(props.notice);
let noticeTimer = 0;
const busy = ref(false);
const stage = ref<HTMLDivElement | null>(null);
const resultCanvas = ref<HTMLCanvasElement | null>(null);
const pageIndex = computed(() => scan.pages.findIndex((p) => p.id === scan.activeId) + 1);

const modes: { id: Mode; label: string; hint: string }[] = [
  { id: "bw", label: "Black & white", hint: "Crisp text, white paper" },
  { id: "gray", label: "Grayscale", hint: "Softer, keeps shading" },
  { id: "color", label: "Colour", hint: "Original tones" },
];

let observer: ResizeObserver | null = null;

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

  const fit = containFit(img.width, img.height, Math.max(40, rect.width - pad), Math.max(40, rect.height - pad));
  const cssW = Math.max(1, Math.round(img.width * fit.scale));
  const cssH = Math.max(1, Math.round(img.height * fit.scale));
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

async function reprocess(options: { rewriteWarp?: boolean } = {}) {
  const current = page.value;
  if (!current) return;
  busy.value = true;
  try {
    await processPage(current, { full: true, rewriteWarp: options.rewriteWarp });
    await nextTick();
    drawResult();
  } finally {
    busy.value = false;
  }
}

function setMode(next: Mode) {
  const current = page.value;
  if (!current || current.opts.mode === next) return;
  current.opts.mode = next;
  void reprocess();
}

function toggleFrame() {
  mode.value = mode.value === "result" ? "frame" : "result";
  if (mode.value === "result") {
    void nextTick(drawResult);
  }
}

function onQuad(next: Quad) {
  const current = page.value;
  if (!current) return;
  current.quad = next;
  current.warped = null;
}

async function onCommit() {
  await reprocess({ rewriteWarp: true });
}

async function runAuto() {
  const current = page.value;
  if (!current) return;
  busy.value = true;
  try {
    const found = autoDetect(current);
    await processPage(current, { full: true, rewriteWarp: true });
    await nextTick();
    if (!found) {
      mode.value = "frame";
    } else {
      drawResult();
    }
  } finally {
    busy.value = false;
  }
}

watch(
  () => page.value?.result,
  () => nextTick(drawResult)
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
    else await nextTick(drawResult);
  }
);

onMounted(async () => {
  observer = new ResizeObserver(() => {
    if (mode.value === "result") drawResult();
  });
  if (stage.value) observer.observe(stage.value);
  if (page.value && !page.value.result) {
    await reprocess({ rewriteWarp: true });
  } else {
    await nextTick(drawResult);
  }
  if (props.notice) {
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => (notice.value = null), 4200);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  window.clearTimeout(noticeTimer);
});

defineExpose({ openFrame: () => (mode.value = "frame") });
</script>

<template>
  <div class="editor" v-if="page">
    <header class="editor-top">
      <button class="round" aria-label="Back to camera" @click="emit('back')">
        <Icon name="back" :size="22" />
      </button>

      <div class="editor-count" aria-live="polite">
        {{ pageIndex }}<span>/{{ scan.pages.length }}</span>
      </div>

      <button
        class="round"
        :class="{ on: mode === 'frame' }"
        :aria-pressed="mode === 'frame'"
        aria-label="Adjust corners"
        @click="toggleFrame"
      >
        <Icon name="crop" :size="20" />
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

      <p v-if="mode === 'frame'" class="frame-hint">
        {{ notice ?? "Drag a corner to adjust" }}
      </p>
      <p v-else-if="notice" class="frame-hint">{{ notice }}</p>

      <button v-if="mode === 'frame'" class="auto-pill" @click="runAuto">
        <Icon name="auto" :size="17" />
        <span>Auto</span>
      </button>

      <Transition name="fade">
        <div v-if="busy" class="busy-chip">
          <span class="spinner" />
        </div>
      </Transition>
    </div>

    <footer class="editor-dock">
      <div class="swatches" role="group" aria-label="Look">
        <button
          v-for="m in modes"
          :key="m.id"
          class="swatch"
          :class="[m.id, { active: page.opts.mode === m.id }]"
          :aria-pressed="page.opts.mode === m.id"
          :aria-label="m.label"
          :title="m.hint"
          @click="setMode(m.id)"
        >
          <span class="swatch-chip" />
        </button>
      </div>

      <button class="done" aria-label="Done with this page" @click="emit('done')">
        <Icon name="check" :size="24" :stroke="2.2" />
      </button>
    </footer>
  </div>
</template>
