<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import CameraView from "./components/CameraView.vue";
import CaptureReview from "./components/CaptureReview.vue";
import EditorView from "./components/EditorView.vue";
import PagesView from "./components/PagesView.vue";
import { sleep, SWEEP_MS } from "./lib/anim";
import { detectPageQuads, fullFrameQuad, type Quad } from "./lib/cv";
import { tap, thump } from "./lib/haptics";
import { preloadPdfWhenIdle } from "./lib/pdf";
import { makeThumb, nextFrame } from "./lib/image";
import {
  addPage,
  FIRST_RENDER,
  flushSave,
  naturalSide,
  processPage,
  restoreProject,
  scan,
  scheduleSave,
} from "./lib/store";

type View = "camera" | "review" | "edit" | "pages";
/** Where a photo came from: the shutter, or a file the user picked. */
type Origin = "camera" | "upload";
type Shot = { img: ImageData; quad: Quad | null; auto: boolean; origin: Origin };

const view = ref<View>("camera");
const scanning = ref(false);
const scanThumb = ref("");
const pending = ref<ImageData | null>(null);
/** Did the viewfinder have detection switched on when the photo was taken? */
const pendingAuto = ref(false);
/** The review sheet is working (a full detection pass), so it must stay put. */
const reviewBusy = ref(false);
/** Which photo this is and what the automatic search is doing. */
const pendingOrigin = ref<Origin>("camera");
const reviewPhase = ref<"idle" | "searching" | "found" | "miss">("idle");
const reviewFound = ref<Quad | null>(null);
/** A second sheet in the same photo: the sheet asks instead of guessing. */
const reviewSecond = ref<Quad | null>(null);
const editorMode = ref<"result" | "frame">("result");
/** Where the editor goes back to: the camera after a shot, the grid after a tap. */
const editorReturn = ref<"camera" | "pages">("camera");
const editorNotice = ref<string | null>(null);

/** Pages brought back from the last session — worth one line, not a dialog. */
const restoredCount = ref(0);

const queue: Shot[] = [];
/** Bumped whenever the review sheet is left, so a slow pass cannot resurrect it. */
let reviewToken = 0;
let busy = false;

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
    pendingOrigin.value = next.origin;
    reviewPhase.value = "idle";
    reviewFound.value = null;
    reviewSecond.value = null;
    view.value = "review";
  }
}

/** Crop with a known quad, then show the result. */
async function applyDetected(img: ImageData, quad: Quad) {
  scanThumb.value = makeThumb(img, 300, 400);
  scanning.value = true;
  thump();
  await nextFrame();
  try {
    const page = addPage(img, "scan");
    page.quad = quad;
    page.warped = null;
    // Enough pixels for the first look and for a sharp thumbnail — never more
    // than the photo actually has, or the page is born slightly soft.
    await processPage(page, {
      full: true,
      rewriteWarp: true,
      maxSide: Math.min(FIRST_RENDER, naturalSide(page)),
    });
    scheduleSave(page);
    editorMode.value = "result";
    editorNotice.value = null;
    editorReturn.value = "camera";
    view.value = "edit";
  } finally {
    scanning.value = false;
  }
}

/**
 * Let the detector have a go on the captured photo.
 *
 * The photo stays on the review sheet while it works, and the amber band makes
 * one full pass from the top of the photo to the bottom — never a loop that
 * stops wherever the detector finished, which made it look as if only the middle
 * of the page had been scanned. When the band has travelled the page and the
 * detector has an answer, the outline draws itself in and *nothing happens by
 * itself*: the sheet waits, with "Use this crop" and "Crop it myself". A
 * detection is a suggestion, not a decision.
 */
async function chooseAuto() {
  const img = pending.value;
  if (!img || reviewBusy.value) return;
  const token = ++reviewToken;
  /** Did the user leave this sheet while the work was running? */
  const abandoned = () => token !== reviewToken;

  reviewBusy.value = true;
  busy = true;
  const started = performance.now();
  try {
    reviewPhase.value = "searching";
    reviewFound.value = null;
    reviewSecond.value = null;

    const quads = safeDetectMany(img);
    // Let the band finish its pass even when the answer arrived early: an
    // animation that stops at 80% is exactly the "halber Scan" this fixes.
    const elapsed = performance.now() - started;
    if (elapsed < SWEEP_MS) await sleep(SWEEP_MS - elapsed);
    if (abandoned()) return;

    if (quads.length > 1) {
      reviewFound.value = quads[0];
      reviewSecond.value = quads[1];
      reviewPhase.value = "found";
      return;
    }

    const quad = quads[0] ?? null;
    if (quad) {
      reviewFound.value = quad;
      reviewPhase.value = "found";
    } else {
      // Nothing found is still an answer: say so, and leave the three ways out
      // on screen instead of opening a crop tool nobody asked for.
      reviewPhase.value = "miss";
    }
  } finally {
    reviewBusy.value = false;
    busy = false;
  }
}

/** "Use this crop": agree with the outline and straighten it. */
async function confirmFound() {
  const img = pending.value;
  const quad = reviewFound.value;
  if (!img || !quad) return;
  reviewToken++;
  pending.value = null;
  reviewPhase.value = "idle";
  reviewFound.value = null;
  reviewSecond.value = null;
  tap();
  await applyDetected(img, quad);
}

/** "Crop it myself" after a search: keep the found quad as the starting point. */
function adjustFound() {
  const img = pending.value;
  if (!img) return;
  reviewToken++;
  pending.value = null;
  reviewPhase.value = "idle";
  tap();
  const page = addPage(img, "scan");
  // The detector already did the work — do not run it a second time
  page.quad = reviewFound.value ?? fullFrameQuad(img.width, img.height);
  page.warped = null;
  reviewFound.value = null;
  reviewSecond.value = null;
  editorMode.value = "frame";
  editorNotice.value = null;
  editorReturn.value = "camera";
  view.value = "edit";
}

/** "Scan both pages": one photo, two pages, the second prepared in the background. */
async function chooseBoth() {
  const img = pending.value;
  const first = reviewFound.value;
  const second = reviewSecond.value;
  if (!img || !first || !second) return;
  reviewToken++;
  pending.value = null;
  reviewPhase.value = "idle";
  reviewFound.value = null;
  reviewSecond.value = null;
  tap();
  await applyMany(img, [first, second]);
}

/** "Just the first one": the same path as agreeing with a single detection. */
async function chooseFirst() {
  await confirmFound();
}

/**
 * Several sheets from one photo. The first opens in the editor; the rest are
 * rendered quietly afterwards, because a page without a thumbnail is a blank
 * tile in the grid and that reads as a bug.
 */
async function applyMany(img: ImageData, quads: Quad[]) {
  const pages = quads.map((quad) => {
    const page = addPage(img, "scan");
    page.quad = quad;
    page.warped = null;
    return page;
  });
  scan.activeId = pages[0].id;
  scanThumb.value = makeThumb(img, 300, 400);
  scanning.value = true;
  thump();
  await nextFrame();
  try {
    await processPage(pages[0], {
      full: true,
      rewriteWarp: true,
      maxSide: Math.min(FIRST_RENDER, naturalSide(pages[0])),
    });
    scheduleSave(pages[0]);
    editorMode.value = "result";
    editorNotice.value = null;
    editorReturn.value = "camera";
    view.value = "edit";
    for (const page of pages.slice(1)) {
      await processPage(page, {
        full: true,
        rewriteWarp: true,
        maxSide: Math.min(FIRST_RENDER, naturalSide(page)),
      });
      scheduleSave(page);
    }
  } finally {
    scanning.value = false;
  }
}

/** Detection can throw on a strange image; that must never strand the flow. */
function safeDetectMany(img: ImageData): Quad[] {
  try {
    return detectPageQuads(img, { effort: "thorough" }, 2);
  } catch (err) {
    console.warn("[scano] detection failed", err);
    return [];
  }
}

function safeDetect(img: ImageData): Quad | null {
  return safeDetectMany(img)[0] ?? null;
}

/** Manual path: the corner tool opens straight away, nothing is processed yet. */
function chooseManual() {
  const img = pending.value;
  if (!img) return;
  reviewToken++;
  pending.value = null;
  tap();
  const page = addPage(img, "scan");
  // a detection guess is a decent starting point, but it never blocks the user
  const guess = safeDetect(img);
  page.quad = guess ?? fullFrameQuad(img.width, img.height);
  page.warped = null;
  editorMode.value = "frame";
  editorNotice.value = null;
  editorReturn.value = "camera";
  view.value = "edit";
}

/** Keep the whole photo as-is. */
function chooseWhole() {
  const img = pending.value;
  if (!img) return;
  reviewToken++;
  pending.value = null;
  tap();
  const page = addPage(img, "scan");
  page.quad = fullFrameQuad(img.width, img.height);
  page.warped = null;
  editorMode.value = "frame";
  editorNotice.value = "Drag the corners if you want a tighter crop";
  editorReturn.value = "camera";
  view.value = "edit";
}

function retake() {
  reviewToken++;
  pending.value = null;
  reviewPhase.value = "idle";
  reviewFound.value = null;
  reviewSecond.value = null;
  view.value = "camera";
  pump();
}

/* ----------------------------------------------------------------- nav */

function onEdit(id: number) {
  scan.activeId = id;
  editorMode.value = "result";
  editorNotice.value = null;
  editorReturn.value = "pages";
  view.value = "edit";
}

/** Leaving the editor: back where the user came from, never a surprise jump. */
function leaveEditor() {
  if (editorReturn.value === "pages") {
    view.value = "pages";
    return;
  }
  goCamera();
}

function goCamera() {
  view.value = "camera";
  pump();
}

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (view.value === "edit") leaveEditor();
  else if (view.value === "pages" || view.value === "review") goCamera();
}

// The file name and paper size are part of the project, not part of a session.
watch(
  () => [scan.format, scan.filename],
  () => scheduleSave()
);

/**
 * A phone can close this tab without warning, and a debounced write that never
 * ran is a scan the user lost. Hiding the app is the last reliable moment.
 */
function flushNow() {
  void flushSave();
}

onMounted(async () => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", flushNow);
  // Bring back last session's pages. Their pixels are decoded lazily, so this
  // costs a database read and nothing else — the camera starts regardless.
  const restored = await restoreProject();
  if (restored && scan.pages.length) {
    restoredCount.value = restored;
    window.setTimeout(() => (restoredCount.value = 0), 5200);
  }
  /**
   * Fetch the PDF engine now, not at the moment of export.
   *
   * It is 370 kB that nobody needs while framing a page, and it is also the one
   * chunk that used to be missing from the cache on a phone that went offline
   * before its first export — where both Save and Share could only fail. Warm it
   * while the camera is up; the service worker keeps it.
   */
  preloadPdfWhenIdle();
});

onBeforeUnmount(() => {
  // a detection pass that is still running must not touch a closed app
  reviewToken++;
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("pagehide", flushNow);
  document.removeEventListener("visibilitychange", flushNow);
  void flushSave();
});
</script>

<template>
  <div class="app">
    <Transition name="view" mode="out-in">
      <CameraView
        v-if="view === 'camera'"
        key="camera"
        :thumbs="scan.pages.map((p) => p.thumb).filter((t): t is string => !!t)"
        :page-count="scan.pages.length"
        :restored="restoredCount"
        @captured="onCaptured"
        @open-pages="view = 'pages'"
      />

      <CaptureReview
        v-else-if="view === 'review' && pending"
        key="review"
        :src="pending"
        :page-count="scan.pages.length"
        :origin="pendingOrigin"
        :detection-on="pendingAuto"
        :busy="reviewBusy"
        :phase="reviewPhase"
        :found="reviewFound"
        :extra="reviewSecond"
        @auto="chooseAuto"
        @manual="chooseManual"
        @whole="chooseWhole"
        @retake="retake"
        @both="chooseBoth"
        @single="chooseFirst"
        @confirm="confirmFound"
        @adjust="adjustFound"
      />

      <EditorView
        v-else-if="view === 'edit'"
        key="edit"
        :initial-mode="editorMode"
        :notice="editorNotice"
        :back-to="editorReturn"
        @back="leaveEditor"
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
