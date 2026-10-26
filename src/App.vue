<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import CameraView from "./components/CameraView.vue";
import CaptureReview from "./components/CaptureReview.vue";
import EditorView from "./components/EditorView.vue";
import PagesView from "./components/PagesView.vue";
import { detectPageQuad, fullFrameQuad, insetQuad, type Quad } from "./lib/cv";
import { makeThumb, nextFrame } from "./lib/image";
import { addPage, processPage, scan } from "./lib/store";

type View = "camera" | "review" | "edit" | "pages";
type Shot = { img: ImageData; quad: Quad | null; auto: boolean };

const view = ref<View>("camera");
const scanning = ref(false);
const scanThumb = ref("");
const pending = ref<ImageData | null>(null);
/** Did the viewfinder have detection switched on when the photo was taken? */
const pendingAuto = ref(false);
const editorMode = ref<"result" | "frame">("result");
const editorNotice = ref<string | null>(null);

const queue: Shot[] = [];
let busy = false;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/* ---------------------------------------------------------------- capture */

function onCaptured(shot: Shot) {
  queue.push(shot);
  pump();
}

/**
 * A shot that already has a detected quad goes straight through; a shot without
 * one is shown to the user, who decides how to crop it. Never guess silently,
 * never ask when the answer is already known.
 */
function pump() {
  if (busy || view.value !== "camera") return;
  const next = queue.shift();
  if (!next) return;
  if (next.quad) {
    busy = true;
    void applyDetected(next.img, next.quad).finally(() => {
      busy = false;
      pump();
    });
  } else {
    pending.value = next.img;
    pendingAuto.value = next.auto;
    view.value = "review";
  }
}

/** Crop with a known quad, then show the result. */
async function applyDetected(img: ImageData, quad: Quad) {
  scanThumb.value = makeThumb(img, 300, 400);
  scanning.value = true;
  await nextFrame();
  try {
    const page = addPage(img, "scan");
    page.quad = insetQuad(quad, 0.005);
    page.warped = null;
    await processPage(page, { full: true, rewriteWarp: true });
    await sleep(300);
    editorMode.value = "result";
    editorNotice.value = null;
    view.value = "edit";
  } finally {
    scanning.value = false;
  }
}

/** Let the detector have a go on the captured photo. */
async function chooseAuto() {
  const img = pending.value;
  if (!img) return;
  pending.value = null;
  busy = true;
  try {
    const quad = detectPageQuad(img, { effort: "thorough" });
    if (quad) {
      await applyDetected(img, quad);
    } else {
      const page = addPage(img, "scan");
      page.quad = fullFrameQuad(img.width, img.height);
      page.warped = null;
      editorMode.value = "frame";
      editorNotice.value = "No page edge found — crop it by hand";
      view.value = "edit";
    }
  } finally {
    busy = false;
    pump();
  }
}

/** Manual path: the corner tool opens straight away, nothing is processed yet. */
function chooseManual() {
  const img = pending.value;
  if (!img) return;
  pending.value = null;
  const page = addPage(img, "scan");
  // a detection guess is a decent starting point, but it never blocks the user
  const guess = detectPageQuad(img, { effort: "fast" });
  page.quad = guess ? insetQuad(guess, 0.005) : fullFrameQuad(img.width, img.height);
  page.warped = null;
  editorMode.value = "frame";
  editorNotice.value = null;
  view.value = "edit";
}

/** Keep the whole photo as-is. */
function chooseWhole() {
  const img = pending.value;
  if (!img) return;
  pending.value = null;
  const page = addPage(img, "scan");
  page.quad = fullFrameQuad(img.width, img.height);
  page.warped = null;
  editorMode.value = "frame";
  editorNotice.value = "Drag the corners if you want a tighter crop";
  view.value = "edit";
}

function retake() {
  pending.value = null;
  view.value = "camera";
  pump();
}

/* ----------------------------------------------------------------- nav */

function onEdit(id: number) {
  scan.activeId = id;
  view.value = "edit";
}

function goCamera() {
  view.value = "camera";
  pump();
}

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (view.value === "edit" || view.value === "pages" || view.value === "review") goCamera();
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="app">
    <Transition name="view" mode="out-in">
      <CameraView
        v-if="view === 'camera'"
        key="camera"
        :thumbs="scan.pages.map((p) => p.thumb).filter((t): t is string => !!t)"
        :page-count="scan.pages.length"
        @captured="onCaptured"
        @open-pages="view = 'pages'"
      />

      <CaptureReview
        v-else-if="view === 'review' && pending"
        key="review"
        :src="pending"
        :page-count="scan.pages.length"
        :detection-on="pendingAuto"
        @auto="chooseAuto"
        @manual="chooseManual"
        @whole="chooseWhole"
        @retake="retake"
      />

      <EditorView
        v-else-if="view === 'edit'"
        key="edit"
        :initial-mode="editorMode"
        :notice="editorNotice"
        @back="goCamera"
        @done="view = 'pages'"
      />

      <PagesView v-else key="pages" @back="goCamera" @edit="onEdit" @add="goCamera" />
    </Transition>

    <Transition name="scan">
      <div v-if="scanning" class="scan-overlay" role="status" aria-live="polite">
        <div class="scan-card">
          <img v-if="scanThumb" :src="scanThumb" alt="" />
          <span class="scan-line" aria-hidden="true" />
        </div>
        <p class="scan-label"><span class="spinner" /> Scanning</p>
      </div>
    </Transition>
  </div>
</template>
