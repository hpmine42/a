<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import CameraView from "./components/CameraView.vue";
import CaptureReview from "./components/CaptureReview.vue";
import EditorView from "./components/EditorView.vue";
import PagesView from "./components/PagesView.vue";
import { SWEEP_MS } from "./lib/anim";
import { detectPageQuads, fullFrameQuad, type Quad } from "./lib/cv";
import { detectPageQuadsAsync } from "./lib/detect-async";
import { tap, thump } from "./lib/haptics";
import { preloadPdfWhenIdle } from "./lib/pdf";
import { imageDataFromFile, looksLikePhoto, makeThumb, nextFrame } from "./lib/image";
import {
  addPage,
  FIRST_RENDER,
  flushSave,
  IMPORT_MAX,
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
/**
 * Photos picked in one go, still on their way in.
 *
 * The files themselves wait here, not decoded bitmaps: ten 3600px photos is
 * about 400 MB of pixels, and decoding the lot before showing the first one is
 * how a phone runs out of memory on an import that looks tiny in the picker.
 */
const incoming: File[] = [];
/** Photos that could not be opened, so the count can be told honestly. */
const failed: string[] = [];
/** How many files the picker handed over in this batch. */
let picked = 0;
/** The last failure line shown, so it is not repeated word for word. */
let lastFailure = "";
/** A picked photo is being decoded right now. */
const decoding = ref(false);
/** How many photos are still waiting — a plain array is not reactive. */
const queued = ref(0);

/** A line about something that did not work — visible on every screen. */
const appNotice = ref<string | null>(null);
let appNoticeTimer = 0;
function note(message: string) {
  appNotice.value = message;
  window.clearTimeout(appNoticeTimer);
  appNoticeTimer = window.setTimeout(() => (appNotice.value = null), 6500);
}

/** Bumped whenever the review sheet is left, so a slow pass cannot resurrect it. */
let reviewToken = 0;
let busy = false;

/* ---------------------------------------------------------------- capture */

function onCaptured(shot: Shot) {
  queue.push(shot);
  queued.value = queue.length + incoming.length;
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
  queued.value = queue.length + incoming.length;
  if (!next) {
    // nothing decoded in hand: the next picked photo can be opened now
    void openNext();
    return;
  }
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
async function applyDetected(img: ImageData, quad: Quad, whole = false) {
  scanThumb.value = makeThumb(img, 300, 400);
  scanning.value = true;
  thump();
  await nextFrame();
  try {
    const page = addPage(img, "scan");
    page.quad = quad;
    page.whole = whole;
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

/* ------------------------------------------------------------- the library */

/**
 * Photos from the library, one at a time.
 *
 * `onFiles` only remembers the list; each file is decoded when the flow is ready
 * for it (this is called again after every finished page), so a ten-photo import
 * needs the memory of one photo. A file that cannot be decoded is reported and
 * skipped — one HEIC in a selection must not cost the other nine.
 */
async function openNext(): Promise<void> {
  if (decoding.value || busy || view.value !== "camera" || !incoming.length) return;
  decoding.value = true;
  try {
    while (incoming.length) {
      const file = incoming.shift()!;
      queued.value = queue.length + incoming.length;
      try {
        const img = await imageDataFromFile(file, IMPORT_MAX);
        onCaptured({ img, quad: null, auto: false, origin: "upload" });
        return;
      } catch (err) {
        console.warn("[scano] could not open", file.name, err);
        failed.push(file.name);
        // say it now: the batch may still have readable photos, and the user
        // should hear about the broken one before the next sheet opens
        reportFailures(false);
      }
    }
  } finally {
    decoding.value = false;
  }
  reportFailures();
}

function reportFailures(reset = true): void {
  if (!failed.length) {
    if (reset) picked = 0;
    return;
  }
  let message: string;
  if (failed.length === picked) {
    const heic = failed.some((name) => /\.(heic|heif)$/i.test(name));
    message = heic
      ? "This photo is HEIC, which this browser cannot open. Export it as JPEG, or take the photo with the camera instead."
      : "This photo could not be opened — try a different one.";
  } else {
    message = `${failed.length} of ${picked} photos could not be opened.`;
  }
  // the same line twice in a row is noise, not information
  if (message !== lastFailure) note(message);
  lastFailure = reset ? "" : message;
  if (!reset) return;
  failed.length = 0;
  picked = 0;
}

/** The picker handed over files: keep the photos, say something about the rest. */
function onFiles(list: File[]): void {
  const photos = list.filter(looksLikePhoto);
  if (!photos.length) {
    note("That file is not a photo — pick a JPEG or PNG.");
    return;
  }
  incoming.push(...photos);
  picked = photos.length;
  queued.value = queue.length + incoming.length;
  void openNext();
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
/**
 * The amber band's one pass, as a promise the review sheet resolves.
 *
 * Timing the reveal with a `sleep` drifts: the component's own clock starts a
 * frame later, the browser may throttle, and the band gets cut a few pixels
 * short of the bottom — which is exactly what "it does not run all the way
 * through" looks like. The sheet now says when the band has left the photo.
 */
let sweepResolve: (() => void) | null = null;
let sweepDone: Promise<void> = Promise.resolve();

function startSweep(): Promise<void> {
  let resolve!: () => void;
  sweepDone = new Promise<void>((r) => (resolve = r));
  sweepResolve = resolve;
  // safety net: a sheet that never reports must not hang the flow
  window.setTimeout(() => resolveSweep(), SWEEP_MS * 4);
  return sweepDone;
}

function resolveSweep() {
  sweepResolve?.();
  sweepResolve = null;
}

/**
 * Let the detector have a go on the captured photo.
 *
 * The photo stays on the review sheet while it works, and the amber band makes
 * one full pass from above the photo to below it — never a loop that stops
 * wherever the detector finished. The detector itself runs in a worker so the
 * band keeps moving while it thinks; only a browser without workers falls back
 * to blocking, and there the pass still completes first.
 *
 * When the band is done and there is an answer, the outline draws itself in and
 * *nothing happens by itself*: the sheet waits, with "Use this crop" and "Crop
 * it myself". A detection is a suggestion, not a decision.
 */
async function chooseAuto() {
  const img = pending.value;
  if (!img || reviewBusy.value) return;
  const token = ++reviewToken;
  /** Did the user leave this sheet while the work was running? */
  const abandoned = () => token !== reviewToken;

  reviewBusy.value = true;
  busy = true;
  try {
    reviewPhase.value = "searching";
    reviewFound.value = null;
    reviewSecond.value = null;
    const swept = startSweep();

    // Off the main thread, so the band is not paused by the detector
    const offThread = detectPageQuadsAsync(img, { limit: 2, effort: "thorough" });
    const [detected] = await Promise.all([offThread, swept]);
    if (abandoned()) return;

    // null means "no worker here": do it inline, after the pass has finished
    const quads = detected ?? safeDetectMany(img);
    if (abandoned()) return;

    if (quads.length > 1) {
      reviewFound.value = quads[0];
      reviewSecond.value = quads[1];
      reviewPhase.value = "found";
      return;
    }

    if (quads.length === 1) {
      reviewFound.value = quads[0];
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
  resolveSweep();
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

/**
 * "Keep the whole photo" means exactly that: no crop tool, no corner hunting.
 *
 * The page is the photo, rendered straight away with the current filter. Opening
 * the corner tool here contradicted the label — the user had just said they do
 * not want a crop — so the crop tool is now only one tap away from the finished
 * page ("Crop" in the editor header), never in the way of it.
 */
async function chooseWhole() {
  const img = pending.value;
  if (!img) return;
  resolveSweep();
  reviewToken++;
  tap();
  // Stay on the sheet until the page exists: clearing `pending` first would
  // unmount the review and flash the pages grid for a frame.
  reviewBusy.value = true;
  try {
    // inset 0: "no crop" has to mean no crop, not "almost no crop"
    await applyDetected(img, fullFrameQuad(img.width, img.height, 0), true);
  } finally {
    reviewBusy.value = false;
    pending.value = null;
    reviewPhase.value = "idle";
    reviewFound.value = null;
    reviewSecond.value = null;
  }
}

function retake() {
  // leaving the sheet must not leave a waiting sweep behind
  resolveSweep();
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
    finishEditing();
    return;
  }
  goCamera();
}

/**
 * Leaving a page.
 *
 * Photos picked in one go (or a burst of shots) wait in the queue. Dropping the
 * user into the grid with only the first page — and the rest hidden until they
 * happen to walk back to the camera — reads as "it imported one of my ten
 * photos". So the next one starts straight away, and the sheet says how many are
 * still waiting.
 */
function finishEditing() {
  if (queue.length || incoming.length) {
    // pump() only lifts photos while the camera is the current view
    view.value = "camera";
    pump();
    return;
  }
  view.value = "pages";
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
  window.clearTimeout(appNoticeTimer);
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
        :decoding="decoding"
        @captured="onCaptured"
        @files="onFiles"
        @notice="note"
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
        :queued="queued"
        @auto="chooseAuto"
        @manual="chooseManual"
        @whole="chooseWhole"
        @retake="retake"
        @both="chooseBoth"
        @single="chooseFirst"
        @confirm="confirmFound"
        @adjust="adjustFound"
        @swept="resolveSweep"
      />

      <EditorView
        v-else-if="view === 'edit'"
        key="edit"
        :initial-mode="editorMode"
        :notice="editorNotice"
        :back-to="editorReturn"
        @back="leaveEditor"
        @done="finishEditing"
      />

      <PagesView v-else key="pages" @back="goCamera" @edit="onEdit" @add="goCamera" />
    </Transition>

    <!-- A line about something that did not work, over whatever is on screen:
         it must survive the sheet that opens right after a failed file. -->
    <Transition name="fade">
      <p v-if="appNotice" class="app-note" role="status" aria-live="polite">{{ appNotice }}</p>
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
