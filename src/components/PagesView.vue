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
  // leaving mid-drag must not leave the auto-scroll loop (or the preview) alive
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
  listen(false);
  drag = null;
  ghost.value = null;
  draggingId.value = null;
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
const grid = ref<HTMLDivElement | null>(null);
/** The card that follows the finger: a preview, not the page itself. */
const ghost = ref<{
  x: number;
  y: number;
  w: number;
  h: number;
  thumb: string;
} | null>(null);
/** The position the page is in *right now* — the badge follows the reorder. */
const dragNum = computed(() => scan.pages.findIndex((p) => p.id === draggingId.value) + 1);
/** Spoken, not shown: where a keyboard move just put the page. */
const moveNote = ref("");

/**
 * What a drag remembers.
 *
 * The slot centres are read once, when the finger goes down, and treated as
 * fixed from then on. That is what makes the preview calm: the cards under the
 * finger glide into their new places, while the geometry the finger is judged
 * against never moves. Scrolling is folded in as a shift.
 */
type Drag = {
  id: number;
  /** Only this pointer drives the drag. */
  pointerId: number;
  /** Offset of the finger inside the card, so the preview does not jump. */
  grabX: number;
  grabY: number;
  /** Where the finger went down, to tell a tap from a drag. */
  downX: number;
  downY: number;
  w: number;
  h: number;
  slots: { x: number; y: number }[];
  scrollStart: number;
  /** The finger has travelled far enough to mean "move", not "tap". */
  lifted: boolean;
};
let drag: Drag | null = null;
/** Latest pointer position, so auto-scrolling can re-aim between moves. */
let pointer = { x: 0, y: 0 };
let scrollRaf = 0;

/** How far a finger has to travel before a press becomes a drag. */
const LIFT_SLOP = 6;
/** How close to the edge of the grid the auto-scroll starts, before scaling. */
const EDGE = 76;

/** The same edge in device-independent pixels: `--u` is 1 on a normal phone. */
function edgePx(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--u");
  const u = parseFloat(raw);
  return EDGE * (Number.isFinite(u) && u > 0 ? u : 1);
}

function gridEl(): HTMLElement | null {
  const el = grid.value as unknown as { $el?: HTMLElement } | HTMLElement | null;
  if (!el) return null;
  return (el as { $el?: HTMLElement }).$el ?? (el as HTMLElement);
}

function cardEls(): HTMLElement[] {
  const root = gridEl();
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(".page-card"));
}

function slotCentres(): { x: number; y: number }[] {
  return cardEls().map((card) => {
    const rect = card.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

/** Which slot the finger is closest to, in the geometry captured at pickup. */
function slotUnder(x: number, y: number): number | null {
  if (!drag?.slots.length) return null;
  const root = gridEl();
  const shift = root ? root.scrollTop - drag.scrollStart : 0;
  let best: number | null = null;
  let bestDist = Infinity;
  drag.slots.forEach((slot, index) => {
    const dist = Math.hypot(x - slot.x, y - (slot.y - shift));
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return best;
}

/**
 * Put the page where the finger is, *while* the finger is still down.
 *
 * This is the difference between a drop marker and Google Keep: the grid
 * rearranges under the drag, so what you see while dragging is what you get.
 * `movePage` writes the order, `<TransitionGroup>` glides the cards that slide
 * out of the way, and the dragged card itself is invisible — its slot is the gap
 * the preview will drop into.
 */
function aim(): void {
  if (!drag?.lifted) return;
  const current = scan.pages.findIndex((p) => p.id === drag!.id);
  if (current === -1) return;
  const target = slotUnder(pointer.x, pointer.y);
  if (target === null || target === current) return;
  movePage(current, target);
  tap();
}

/** Scroll the grid when the finger reaches an edge — twelve pages do not fit. */
function autoScroll(): void {
  if (!drag) {
    scrollRaf = 0;
    return;
  }
  const root = gridEl();
  if (root && drag.lifted) {
    const rect = root.getBoundingClientRect();
    const edge = edgePx();
    let step = 0;
    if (pointer.y < rect.top + edge) step = -Math.ceil((rect.top + edge - pointer.y) / 3);
    else if (pointer.y > rect.bottom - edge) step = Math.ceil((pointer.y - (rect.bottom - edge)) / 3);
    if (step) {
      root.scrollTop += Math.max(-24, Math.min(24, step));
      aim();
    }
  }
  scrollRaf = requestAnimationFrame(autoScroll);
}

function paintGhost(x: number, y: number): void {
  if (!drag) return;
  ghost.value = {
    x: x - drag.grabX,
    y: y - drag.grabY,
    w: drag.w,
    h: drag.h,
    thumb: scan.pages.find((p) => p.id === drag!.id)?.thumb ?? "",
  };
}

/**
 * The same move, without a finger.
 *
 * Arrow keys on the grip reorder too — and say where the page went, because a
 * screen reader does not see the card slide.
 */
function keyMove(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= scan.pages.length) return;
  movePage(index, target);
  tap();
  moveNote.value = `Page moved to position ${target + 1} of ${scan.pages.length}`;
}

/**
 * Where the drag listens.
 *
 * Not on the grip. The moment the order changes, Vue moves the card's DOM node
 * to its new slot — and moving a node releases pointer capture, which the
 * browser reports as a cancel. That is the "it hangs as soon as the others
 * shuffle and you cannot drag any more": the capture died with the move. So the
 * page listens on `window`, which no reorder can take away.
 */
function listen(on: boolean): void {
  if (on) {
    window.addEventListener("pointermove", onDragMove as EventListener, { passive: false });
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
    // a phone call, a notification shade, a backgrounded app: the finger is gone
    window.addEventListener("blur", onDragEnd);
  } else {
    window.removeEventListener("pointermove", onDragMove as EventListener);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    window.removeEventListener("blur", onDragEnd);
  }
}

function onGripDown(event: PointerEvent, id: number) {
  if (busy.value) return;
  const card = (event.currentTarget as HTMLElement).closest<HTMLElement>(".page-card");
  const rect = card?.getBoundingClientRect();
  tap();
  drag = {
    id,
    pointerId: event.pointerId,
    grabX: rect ? event.clientX - rect.left : 0,
    grabY: rect ? event.clientY - rect.top : 0,
    downX: event.clientX,
    downY: event.clientY,
    w: rect?.width ?? 0,
    h: rect?.height ?? 0,
    slots: slotCentres(),
    scrollStart: gridEl()?.scrollTop ?? 0,
    lifted: false,
  };
  pointer = { x: event.clientX, y: event.clientY };
  // Deliberately *not* hiding the card yet: until the finger has travelled far
  // enough, this is still a tap, and a card that blanks under the finger for a
  // frame reads as a flicker.
  listen(true);
  event.preventDefault();
}

function onDragMove(event: PointerEvent) {
  if (!drag) return;
  // a second finger is not a second drag
  if (event.pointerId !== drag.pointerId) return;
  pointer = { x: event.clientX, y: event.clientY };
  if (!drag.lifted) {
    if (Math.hypot(event.clientX - drag.downX, event.clientY - drag.downY) < LIFT_SLOP) return;
    drag.lifted = true;
    thump();
    // hide the card and show the preview in the same tick, so there is never a
    // frame where the page has simply vanished
    draggingId.value = drag.id;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
  }
  paintGhost(event.clientX, event.clientY);
  aim();
  if (event.cancelable) event.preventDefault();
}

/** Pointer up, cancel, or the window losing focus: all three end the drag. */
function onDragEnd() {
  if (!drag) return;
  const lifted = drag.lifted;
  drag = null;
  ghost.value = null;
  draggingId.value = null;
  listen(false);
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
  }
  if (!lifted) return;
  // The order is already what the finger chose; there is nothing to apply here.
  thump();
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

    <!--
      TransitionGroup, so a reorder is a move rather than a jump: the cards that
      slide out of the way are animated by the browser (FLIP), which is what makes
      the live preview read as "it will land here" instead of "it flickered".
    -->
    <TransitionGroup name="card" tag="div" class="pages-grid" ref="grid">
      <p v-if="!scan.pages.length" key="empty" class="pages-empty">
        <strong>No pages yet</strong>
        <span>Take a photo of a document. Nothing leaves this device.</span>
      </p>

      <figure
        v-for="(page, i) in scan.pages"
        :key="page.id"
        class="page-card"
        :class="{ dragging: draggingId === page.id }"
      >
        <button class="page-thumb" :aria-label="`Edit page ${i + 1}`" @click="emit('edit', page.id)">
          <img v-if="page.thumb" :src="page.thumb" alt="" />
          <span class="page-num">{{ i + 1 }}</span>
        </button>
        <button
          class="page-grip"
          :aria-label="`Reorder page ${i + 1}: drag, or use the arrow keys to move it`"
          @pointerdown="onGripDown($event, page.id)"
          @keydown.left.prevent="keyMove(i, -1)"
          @keydown.up.prevent="keyMove(i, -1)"
          @keydown.right.prevent="keyMove(i, 1)"
          @keydown.down.prevent="keyMove(i, 1)"
        >
          <Icon name="grip" :size="16" />
        </button>
        <button class="page-del" :aria-label="`Remove page ${i + 1}`" @click="dropPage(page.id)">
          <Icon name="close" :size="15" :stroke="2.2" />
        </button>
      </figure>

      <button key="add" class="page-add" aria-label="Add pages" @click="emit('add')">
        <Icon name="plus" :size="24" />
        <span>Add page</span>
      </button>
    </TransitionGroup>

    <!-- The card under the finger. Outside the grid (and outside its clipping),
         so it can hang over the edges the way a held note does. -->
    <Teleport to="body">
      <div
        v-if="ghost"
        class="drag-ghost"
        aria-hidden="true"
        :style="{
          width: `${ghost.w}px`,
          height: `${ghost.h}px`,
          transform: `translate3d(${ghost.x}px, ${ghost.y}px, 0)`,
        }"
      >
        <img v-if="ghost.thumb" :src="ghost.thumb" alt="" />
        <span class="drag-ghost-num">{{ dragNum }}</span>
      </div>
    </Teleport>

    <p class="sr-live" role="status" aria-live="polite">{{ moveNote }}</p>

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
