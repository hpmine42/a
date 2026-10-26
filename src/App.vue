<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import CameraView from "./components/CameraView.vue";
import EditorView from "./components/EditorView.vue";
import PagesView from "./components/PagesView.vue";
import { makeThumb } from "./lib/image";
import { addPage, autoDetect, processPage, scan } from "./lib/store";

type View = "camera" | "edit" | "pages";

const view = ref<View>("camera");
const scanning = ref(false);
const scanThumb = ref("");
const editor = ref<InstanceType<typeof EditorView> | null>(null);

const queue: ImageData[] = [];
let ingesting = false;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function ingest(img: ImageData) {
  scanThumb.value = makeThumb(img, 300, 400);
  scanning.value = true;
  const page = addPage(img, "scan");
  const found = autoDetect(page);
  await processPage(page, { full: true, rewriteWarp: true });
  await sleep(380);
  scanning.value = false;
  view.value = "edit";
  if (!found) {
    // nothing detected: open the manual frame tool instead of pretending
    await nextTick();
    editor.value?.openFrame();
  }
}

async function drain() {
  ingesting = true;
  try {
    while (queue.length) {
      const img = queue.shift()!;
      await ingest(img);
    }
  } finally {
    ingesting = false;
  }
}

function onCaptured(img: ImageData) {
  queue.push(img);
  if (!ingesting) void drain();
}

function onEdit(id: number) {
  scan.activeId = id;
  view.value = "edit";
}

function goCamera() {
  view.value = "camera";
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

      <EditorView
        v-else-if="view === 'edit'"
        key="edit"
        ref="editor"
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
