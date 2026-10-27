<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";
import { tap, thump } from "../lib/haptics";
import {
  buildPdf,
  downloadBlob,
  ExportError,
  pdfFilename,
  preloadPdfWhenIdle,
  type BuiltPdf,
  type PageFormat,
} from "../lib/pdf";
import { sharePdf, sharingSupported } from "../lib/share";
import {
  clearPages,
  insertPage,
  insertPages,
  movePage,
  removePage,
  scan,
  scheduleSave,
  type Page,
} from "../lib/store";

const emit = defineEmits<{ (e: "back"): void; (e: "edit", id: number): void; (e: "add"): void }>();

const busy = ref(false);
const progress = ref({ done: 0, total: 0 });
const error = ref<string | null>(null);
const nameField = ref<HTMLInputElement | null>(null);
/** What the last export did, so the button can say it worked. */
const result = ref<string | null>(null);
let resultTimer = 0;

const isBusy = computed(() => busy.value);
const progressPct = computed(() =>
  progress.value.total ? Math.round((progress.value.done / progress.value.total) * 100) : 0
);

/* ------------------------------------------------------------------- undo */

/**
 * Removing a page is one fat-finger away from destroying a scan, and there is no
 * re-shoot. Instead of a confirm dialog (which everyone dismisses) the action
 * is reversible for a few seconds.
 */
const undo = ref<{ label: string; run: () => void } | null>(null);
let undoTimer = 0;

function offerUndo(label: string, run: () => void) {
  undo.value = { label, run };
  window.clearTimeout(undoTimer);
  undoTimer = window.setTimeout(() => (undo.value = null), 6000);
}

function takeUndo() {
  const pendingUndo = undo.value;
  undo.value = null;
  window.clearTimeout(undoTimer);
  if (!pendingUndo) return;
  tap();
  pendingUndo.run();
}

function dropPage(id: number) {
  const index = scan.pages.findIndex((p) => p.id === id);
  if (index === -1) return;
  const page = scan.pages[index];
  tap();
  removePage(id);
  offerUndo("Page removed", () => insertPage(page as Page, index));
}

function dropAll() {
  if (!scan.pages.length) return;
  const saved = scan.pages.slice();
  tap();
  clearPages();
  offerUndo(saved.length === 1 ? "Page removed" : `${saved.length} pages removed`, () => insertPages(saved));
}

const formats: { id: PageFormat; label: string; hint: string }[] = [
  { id: "a4", label: "A4", hint: "Print on A4, 4% margin" },
  { id: "letter", label: "Letter", hint: "US Letter, 4% margin" },
  { id: "fit", label: "Fit", hint: "Page matches the scan exactly" },
];
const label = computed(() => (scan.pages.length === 1 ? "1 page" : `${scan.pages.length} pages`));

/** A friendly default: "Scano 2026-10-26", editable before saving. */
function suggestedName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Scano ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Get the PDF engine and, when the phone is idle, the PDF itself ready.
 *
 * This is the grid, i.e. the screen where people export. Doing the work now
 * means the tap on Share has a file in hand — which is the only way a share
 * sheet can open on a phone, because the permission to share expires seconds
 * after the tap that asked for it.
 */
onMounted(() => {
  if (!scan.filename) scan.filename = suggestedName();
  canShare.value = sharingSupported();
  const idle = (cb: () => void) =>
    typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(cb, { timeout: 2500 })
      : window.setTimeout(cb, 600);
  idle(() => {
    preloadPdfWhenIdle();
    if (scan.pages.length) void prepare(false);
  });
});

onBeforeUnmount(() => {
  window.clearTimeout(undoTimer);
  window.clearTimeout(resultTimer);
});

const finalName = computed(() => pdfFilename(scan.filename, scan.pages.length));

function note(message: string) {
  result.value = message;
  window.clearTimeout(resultTimer);
  resultTimer = window.setTimeout(() => (result.value = null), 4200);
}

/** Anything about the project the PDF depends on. */
function revision(): string {
  return [
    scan.format,
    scan.filename,
    ...scan.pages.map((p) => `${p.id}:${p.rotation}:${p.opts.optimize ? 1 : 0}`),
  ].join("|");
}

/**
 * A built PDF that is still current.
 *
 * The reason this exists is not speed: a phone only lets you share a file for a
 * few seconds after a tap, and building a multi-page PDF takes longer than that.
 * Building ahead means the *share* tap can hand over a ready file immediately,
 * and a second tap after a slow first one always works.
 */
const prepared = ref<BuiltPdf | null>(null);
let preparedKey = "";
/** A build that is running right now, so two taps cannot start two builds. */
let inFlight: Promise<BuiltPdf | null> | null = null;

const freshPrepared = (): BuiltPdf | null =>
  prepared.value && preparedKey === revision() ? prepared.value : null;

/**
 * Have a current PDF ready.
 *
 * `interactive` decides whether the person waiting sees progress: a build that
 * starts on its own when the grid opens must not hijack the buttons, while one
 * started by a tap must say what it is doing.
 */
async function prepare(interactive: boolean): Promise<BuiltPdf | null> {
  const fresh = freshPrepared();
  if (fresh) return fresh;

  if (!inFlight) {
    inFlight = (async () => {
      try {
        const built = await buildPdf(
          scan.pages,
          scan.format,
          (done, total) => (progress.value = { done, total }),
          scan.filename
        );
        prepared.value = built;
        preparedKey = revision();
        return built;
      } catch (err) {
        console.error("[scano] could not build the PDF", err);
        if (interactive) error.value = exportMessage(err, "build");
        // a background failure is not news; a tapped one is
        return null;
      } finally {
        inFlight = null;
      }
    })();
  }

  if (!interactive) return inFlight;
  busy.value = true;
  error.value = null;
  try {
    const built = await inFlight;
    if (!built) error.value = exportMessage(new ExportError("render"), "build");
    return built;
  } finally {
    busy.value = false;
  }
}

/** The truth, in words a person can act on. */
function exportMessage(err: unknown, stage: "build" | "download"): string {
  if (err instanceof ExportError) {
    return err.reason === "engine"
      ? "The PDF engine did not load — check your connection, then try again."
      : "One page could not be rendered — open it, re-crop it, and try again.";
  }
  return stage === "download"
    ? "Could not save the file — try again."
    : "Could not build the PDF — try again.";
}

async function savePdf() {
  if (!scan.pages.length || busy.value) return;
  const built = await prepare(true);
  if (!built) return;
  try {
    downloadBlob(built.blob, built.filename);
    note(`Saved ${built.filename}`);
  } catch (err) {
    console.error(err);
    error.value = exportMessage(err, "download");
  }
}

/** Only offered when the browser can actually put a file in the share sheet. */
const canShare = ref(false);
const shareable = computed(() => canShare.value && !busy.value && scan.pages.length > 0);

async function shareOut() {
  if (!scan.pages.length || busy.value) return;
  // The fast path is the important one: a ready file shares inside the tap.
  const ready = freshPrepared();
  const built = ready ?? (await prepare(true));
  if (!built) return;
  const outcome = await sharePdf(built.blob, built.filename);
  if (outcome === "shared") note("Shared");
  else if (outcome === "stale") note("PDF ready — tap Share again");
  else if (outcome === "dismissed") {
    /* the user closed the sheet; nothing to report */
  } else if (outcome === "unsupported" || outcome === "failed") {
    // no share sheet after all: the honest fallback is the file itself
    try {
      downloadBlob(built.blob, built.filename);
      note(`Saved ${built.filename}`);
    } catch (err) {
      console.error(err);
      error.value = exportMessage(err, "download");
    }
  }
}

/* ---------------------------------------------------------------- reorder */

/**
 * Dragging a page to another slot.
 *
 * Touch browsers have no HTML5 drag, so the gesture is built from pointer
 * events: press the grip, move, and the card under the finger marks the slot it
 * would take. Only the page order is ever written, never the pixels.
 */
const draggingId = ref<number | null>(null);
const dropIndex = ref<number | null>(null);
const grid = ref<HTMLDivElement | null>(null);
let gripStart = { x: 0, y: 0, id: 0, from: 0 };
let gripMoved = false;

function onGripDown(event: PointerEvent, id: number, index: number) {
  if (busy.value) return;
  tap();
  gripStart = { x: event.clientX, y: event.clientY, id, from: index };
  gripMoved = false;
  draggingId.value = id;
  dropIndex.value = null;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function slotUnder(x: number, y: number): number | null {
  const cards = grid.value?.querySelectorAll<HTMLElement>(".page-card");
  if (!cards?.length) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  cards.forEach((card, index) => {
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // inside the card is an obvious answer; nearest centre is the tie-break
    const dist = Math.hypot(x - cx, y - cy);
    const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    const weighted = inside ? dist - 1e6 : dist;
    if (weighted < bestDist) {
      bestDist = weighted;
      best = index;
    }
  });
  return best;
}

function onGripMove(event: PointerEvent) {
  if (draggingId.value === null) return;
  if (!gripMoved && Math.hypot(event.clientX - gripStart.x, event.clientY - gripStart.y) < 6) return;
  gripMoved = true;
  dropIndex.value = slotUnder(event.clientX, event.clientY);
  event.preventDefault();
}

function onGripUp(event: PointerEvent) {
  const id = draggingId.value;
  const target = dropIndex.value;
  draggingId.value = null;
  dropIndex.value = null;
  try {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  } catch {
    /* capture may already be gone */
  }
  if (id === null || target === null || !gripMoved) return;
  const from = scan.pages.findIndex((p) => p.id === gripStart.id);
  if (from === -1 || from === target) return;
  thump();
  movePage(from, target);
}
</script>

<template>
  <div class="pages">
    <header class="pages-top">
      <button class="control" aria-label="Back to camera" @click="emit('back')">
        <Icon name="back" :size="19" />
        <span>Camera</span>
      </button>
      <span class="pages-count">{{ label }}</span>
      <button class="control danger" aria-label="Delete all pages" :disabled="isBusy" @click="dropAll">
        <Icon name="trash" :size="18" />
        <span>Clear</span>
      </button>
    </header>

    <div class="pages-grid" ref="grid">
      <p v-if="!scan.pages.length" class="pages-empty">
        <strong>No pages yet</strong>
        <span>Take a photo of a document. Nothing leaves this device.</span>
      </p>

      <figure
        v-for="(page, i) in scan.pages"
        :key="page.id"
        class="page-card"
        :class="{
          dragging: draggingId === page.id,
          'drop-before': dropIndex === i && draggingId !== null && draggingId !== page.id,
        }"
      >
        <button class="page-thumb" :aria-label="`Edit page ${i + 1}`" @click="emit('edit', page.id)">
          <img v-if="page.thumb" :src="page.thumb" alt="" />
          <span class="page-num">{{ i + 1 }}</span>
        </button>
        <button
          class="page-grip"
          :aria-label="`Reorder page ${i + 1}: drag, or use the arrow keys to move it`"
          @pointerdown="onGripDown($event, page.id, i)"
          @pointermove="onGripMove"
          @pointerup="onGripUp"
          @pointercancel="onGripUp"
          @keydown.left.prevent="movePage(i, i - 1)"
          @keydown.up.prevent="movePage(i, i - 1)"
          @keydown.right.prevent="movePage(i, i + 1)"
          @keydown.down.prevent="movePage(i, i + 1)"
        >
          <Icon name="grip" :size="16" />
        </button>
        <button class="page-del" :aria-label="`Remove page ${i + 1}`" @click="dropPage(page.id)">
          <Icon name="close" :size="15" :stroke="2.2" />
        </button>
      </figure>

      <button class="page-add" aria-label="Add pages" @click="emit('add')">
        <Icon name="plus" :size="24" />
        <span>Add page</span>
      </button>
    </div>

    <div v-if="undo" class="undo-bar" role="status" aria-live="polite">
      <span>{{ undo.label }}</span>
      <button class="undo-action" @click="takeUndo">Undo</button>
    </div>

    <footer class="pages-dock">
      <label class="name-field" for="pdf-name">
        <span class="name-label">File name</span>
        <span class="name-input">
          <input
            id="pdf-name"
            ref="nameField"
            v-model="scan.filename"
            type="text"
            inputmode="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            maxlength="80"
            placeholder="Scano 2026-10-26"
            :aria-describedby="'pdf-name-hint'"
          />
          <span class="name-ext" aria-hidden="true">.pdf</span>
        </span>
      </label>
      <p id="pdf-name-hint" class="name-hint">
        Saves as <strong>{{ finalName }}</strong>
      </p>

      <div class="paper-row" role="group" aria-label="Paper size">
        <button
          v-for="option in formats"
          :key="option.id"
          class="paper"
          :class="{ active: scan.format === option.id }"
          :aria-pressed="scan.format === option.id"
          :title="option.hint"
          @click="scan.format = option.id; scheduleSave()"
        >
          {{ option.label }}
        </button>
      </div>
      <p v-if="error" class="pages-error">{{ error }}</p>
      <p v-else-if="result" class="pages-result" role="status">{{ result }}</p>

      <div class="export-row">
        <button class="save" :disabled="isBusy || !scan.pages.length" @click="savePdf">
        <span
          v-if="isBusy"
          class="save-bar"
          aria-hidden="true"
          :style="{ width: `${Math.max(6, progressPct)}%` }"
        />
          <Icon name="pdf" :size="19" />
          <span>{{ isBusy ? `Building ${progress.done}/${progress.total}…` : "Save PDF" }}</span>
        </button>

        <button
          v-if="shareable"
          class="share-pdf"
          aria-label="Share the PDF"
          :disabled="isBusy"
          @click="shareOut"
        >
          <Icon name="share" :size="19" />
          <span>Share</span>
        </button>
      </div>
    </footer>
  </div>
</template>
