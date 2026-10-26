<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import CameraView from "./components/CameraView.vue";
import CaptureReview from "./components/CaptureReview.vue";
import EditorView from "./components/EditorView.vue";
import PagesView from "./components/PagesView.vue";
import { makeThumb } from "./lib/image";
import { addPage, autoDetect, processPage, scan } from "./lib/store";

type View = "camera" | "review" | "edit" | "pages";

const view = ref<View>("camera");
const scanning = ref(false);
const scanThumb = ref("");
const pending = ref<ImageData | null>(null);
const editorMode = ref<"result" | "frame">("result");
const editorNotice = ref<string | null>(null);

const queue: ImageData[] = [];
let pumping = false;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Every shot lands in the review step first — auto or manual is the user's call. */
function onCaptured(img: ImageData) {
  queue.push(img);
  pump();
}

function pump() {
  if (pumping || view.value !== "camera") return;
  const next = queue.shift();
  if (!next) return;
  pending.value = next;
  view.value = "review";
}

/** Automatic path: detect, warp, enhance, then show the result. */
async function chooseAuto() {
  const img = pending.value;
  if (!img) return;
  pumping = true;
  scanThumb.value = makeThumb(img, 300, 400);
  scanning.value = true;
  try {
    const page = addPage(img, "scan");
    const found = autoDetect(page);
    await processPage(page, { full: true, rewriteWarp: true });
    await sleep(340);
    editorMode.value = found ? "result" : "frame";
    editorNotice.value = found ? null : "No page edge found — drag the corners";
    view.value = "edit";
  } finally {
    scanning.value = false;
    pending.value = null;
    pumping = false;
    pump();
  }
}

/** Manual path: open the corner tool straight away, nothing is processed yet. */
function chooseManual() {
  const img = pending.value;
  if (!img) return;
  const page = addPage(img, "scan");
  // a detection guess is a good starting point, but it never blocks the user
  autoDetect(page);
  editorMode.value = "frame";
  editorNotice.value = null;
  pending.value = null;
  view.value = "edit";
  pump();
}

function retake() {
  pending.value = null;
  view.value = "camera";
  pump();
}

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
  if (view.value === "edit") goCamera();
  else if (view.value === "pages") goCamera();
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
        @auto="chooseAuto"
        @manual="chooseManual"
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

      <PagesView
        v-else
        key="pages"
        @back="goCamera"
        @edit="onEdit"
        @add="goCamera"
      />
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
