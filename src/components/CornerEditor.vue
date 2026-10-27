<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Pt, Quad } from "../lib/cv";
import { prefersReducedMotion, SWEEP_MS } from "../lib/anim";
import { canvasFor } from "../lib/image";
import { clampToBox, containFit, loupeSourceRect, toImagePoint, type Fit } from "../lib/geometry";

const props = defineProps<{
  src: ImageData;
  quad: Quad;
  /** A detection pass is running: show a sweep so the wait has a reason. */
  searching?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:quad", quad: Quad): void;
  (e: "commit"): void;
}>();

const host = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const hovering = ref(false);
/** Which corner the keyboard is on (null = none), for arrow-key nudging. */
const focused = ref<number | null>(null);
/** Where the four handles are on screen, so the real buttons sit on them. */
const handlePts = ref<Pt[]>([]);

let ctx: CanvasRenderingContext2D | null = null;
let observer: ResizeObserver | null = null;
let raf = 0;
let dirty = true;
/** Sweep progress 0..1 while `searching`, driven by its own clock. */
let sweep = 0;
let sweepRaf = 0;

type Drag =
  | { kind: "corner"; index: number }
  | { kind: "whole"; start: Pt; origin: Quad }
  | null;
let drag: Drag = null;

const HANDLE_R = 13;
const TOUCH_R = 34;

function markDirty() {
  dirty = true;
  if (!raf) raf = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------- sweep */

/**
 * One pass, top to bottom.
 *
 * It used to loop and to be cut short the moment the detector answered, so the
 * band stopped somewhere in the middle of the sheet — which is exactly what made
 * the scan look like it gave up halfway. `runAuto` now waits for this pass.
 */
function startSweep() {
  if (sweepRaf || prefersReducedMotion()) return;
  sweep = 0;
  const start = performance.now();
  const step = (now: number) => {
    sweep = Math.min(1, (now - start) / SWEEP_MS);
    markDirty();
    if (sweep < 1) sweepRaf = requestAnimationFrame(step);
    else sweepRaf = 0;
  };
  sweepRaf = requestAnimationFrame(step);
}

function stopSweep() {
  if (sweepRaf) cancelAnimationFrame(sweepRaf);
  sweepRaf = 0;
  sweep = 0;
  markDirty();
}

watch(
  () => props.searching,
  (on) => (on ? startSweep() : stopSweep())
);

function fit() {
  const el = canvas.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { rect, ...containFit(props.src.width, props.src.height, rect.width, rect.height) };
}

function toImage(clientX: number, clientY: number): Pt | null {
  const el = canvas.value;
  const f = fit();
  if (!el || !f) return null;
  const rect = el.getBoundingClientRect();
  return toImagePoint({ x: clientX - rect.left, y: clientY - rect.top }, f);
}

function insidePolygon(p: Pt, quad: Quad): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = quad[i];
    const b = quad[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/* ------------------------------------------------------------------ render */

function tick() {
  raf = 0;
  if (!dirty) return;
  dirty = false;
  render();
}

function render() {
  const el = canvas.value;
  if (!el) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
  }
  if (!ctx) ctx = el.getContext("2d");
  const g = ctx;
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const f = containFit(props.src.width, props.src.height, w, h);
  g.drawImage(canvasFor(props.src), f.dx, f.dy, props.src.width * f.scale, props.src.height * f.scale);

  const pts = props.quad.map((p) => ({ x: p.x * f.scale + f.dx, y: p.y * f.scale + f.dy }));

  // dim the photo outside the sheet
  g.save();
  g.beginPath();
  g.rect(f.dx, f.dy, props.src.width * f.scale, props.src.height * f.scale);
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.fillStyle = "rgba(8, 9, 11, 0.62)";
  g.fill("evenodd");
  g.restore();

  // sheet outline
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.lineWidth = 1.75;
  g.strokeStyle = "rgba(255, 255, 255, 0.9)";
  g.stroke();

  // rule-of-thirds guides inside the sheet
  g.save();
  g.setLineDash([4, 6]);
  g.lineWidth = 1;
  g.strokeStyle = "rgba(255, 255, 255, 0.24)";
  for (let i = 1; i < 3; i++) {
    const t = i / 3;
    g.beginPath();
    g.moveTo(pts[0].x + (pts[3].x - pts[0].x) * t, pts[0].y + (pts[3].y - pts[0].y) * t);
    g.lineTo(pts[1].x + (pts[2].x - pts[1].x) * t, pts[1].y + (pts[2].y - pts[1].y) * t);
    g.stroke();
    g.beginPath();
    g.moveTo(pts[0].x + (pts[1].x - pts[0].x) * t, pts[0].y + (pts[1].y - pts[0].y) * t);
    g.lineTo(pts[3].x + (pts[2].x - pts[3].x) * t, pts[3].y + (pts[2].y - pts[3].y) * t);
    g.stroke();
  }
  g.restore();

  // The sweep: a soft amber band travelling down the photo, clipped to the
  // sheet, so "looking for the page" has a visible heartbeat for the ~200ms the
  // detector needs instead of a frozen picture.
  if (props.searching) {
    const top = f.dy;
    const height = props.src.height * f.scale;
    const y = top + height * (0.02 + sweep * 0.96);
    g.save();
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
    g.clip();
    const band = g.createLinearGradient(0, y - 46, 0, y + 46);
    band.addColorStop(0, "rgba(255, 192, 97, 0)");
    band.addColorStop(0.5, "rgba(255, 192, 97, 0.22)");
    band.addColorStop(1, "rgba(255, 192, 97, 0)");
    g.fillStyle = band;
    g.fillRect(f.dx, y - 46, props.src.width * f.scale, 92);
    g.globalAlpha = sweep > 0.9 ? Math.max(0, 1 - (sweep - 0.9) / 0.1) : 1;
    g.beginPath();
    g.moveTo(f.dx, y);
    g.lineTo(f.dx + props.src.width * f.scale, y);
    g.lineWidth = 2;
    g.strokeStyle = "rgba(255, 214, 152, 0.9)";
    g.stroke();
    g.globalAlpha = 1;
    g.restore();
  }

  // handles
  handlePts.value = pts;
  pts.forEach((p, i) => {
    const active = (drag?.kind === "corner" && drag.index === i) || focused.value === i;
    g.beginPath();
    g.arc(p.x, p.y, active ? HANDLE_R + 3 : HANDLE_R, 0, Math.PI * 2);
    g.fillStyle = "rgba(10, 11, 13, 0.55)";
    g.fill();
    g.lineWidth = active ? 3.2 : 2.4;
    g.strokeStyle = "#ffc061";
    g.stroke();
    g.beginPath();
    g.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
    g.fillStyle = "#ffc061";
    g.fill();
  });

  // magnifier while dragging a corner: fine positioning on a phone needs it
  if (drag?.kind === "corner") {
    drawLoupe(pts[drag.index], f, w, h);
  }
}

function drawLoupe(handle: Pt, f: Fit, w: number, h: number) {
  const g = ctx;
  if (!g) return;
  const R = 58;
  const zoom = 2.6;

  // sit the loupe away from the finger, then keep it inside the stage
  const preferred = {
    x: handle.x + (handle.x > w * 0.5 ? -R - 40 : R + 40),
    y: handle.y + (handle.y > h * 0.5 ? -R - 34 : R + 34),
  };
  const centre = clampToBox(preferred, R, w, h);

  const src = loupeSourceRect(handle, f, R, zoom);
  g.save();
  g.beginPath();
  g.arc(centre.x, centre.y, R, 0, Math.PI * 2);
  g.closePath();
  g.clip();
  g.fillStyle = "#0a0b0d";
  g.fillRect(centre.x - R, centre.y - R, R * 2, R * 2);

  const img = canvasFor(props.src);
  g.imageSmoothingQuality = "high";
  g.drawImage(img, src.sx, src.sy, src.size, src.size, centre.x - R, centre.y - R, R * 2, R * 2);

  // reticle marks the exact pixel under the corner
  g.strokeStyle = "rgba(255, 192, 97, 0.95)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(centre.x - 11, centre.y);
  g.lineTo(centre.x - 4, centre.y);
  g.moveTo(centre.x + 4, centre.y);
  g.lineTo(centre.x + 11, centre.y);
  g.moveTo(centre.x, centre.y - 11);
  g.lineTo(centre.x, centre.y - 4);
  g.moveTo(centre.x, centre.y + 4);
  g.lineTo(centre.x, centre.y + 11);
  g.stroke();
  g.beginPath();
  g.arc(centre.x, centre.y, 2, 0, Math.PI * 2);
  g.fillStyle = "rgba(255, 192, 97, 0.95)";
  g.fill();
  g.restore();

  // ring + a hairline back to the handle, so it is obvious what is magnified
  g.beginPath();
  g.arc(centre.x, centre.y, R, 0, Math.PI * 2);
  g.lineWidth = 2;
  g.strokeStyle = "rgba(255, 192, 97, 0.95)";
  g.stroke();

  g.save();
  g.setLineDash([3, 4]);
  g.lineWidth = 1;
  g.strokeStyle = "rgba(255, 192, 97, 0.45)";
  const len = Math.hypot(centre.x - handle.x, centre.y - handle.y);
  if (len > R + 4) {
    const t = (len - R) / len;
    g.beginPath();
    g.moveTo(handle.x, handle.y);
    g.lineTo(handle.x + (centre.x - handle.x) * t, handle.y + (centre.y - handle.y) * t);
    g.stroke();
  }
  g.restore();
}

/* --------------------------------------------------------------- keyboard */

/**
 * The same four handles, reachable without a finger.
 *
 * A canvas is invisible to assistive technology and impossible to nudge with a
 * keyboard, which is a poor excuse for making precise work mouse-only. Invisible
 * buttons sit exactly on the handles; Tab reaches them, arrows move them by a
 * pixel (ten with Shift), and the canvas draws the ring so the focus is visible.
 */
function nudge(index: number, dx: number, dy: number): void {
  const next = props.quad.map((p) => ({ ...p })) as Quad;
  const clampX = (v: number) => Math.max(0, Math.min(props.src.width, v));
  const clampY = (v: number) => Math.max(0, Math.min(props.src.height, v));
  next[index] = { x: clampX(next[index].x + dx), y: clampY(next[index].y + dy) };
  emit("update:quad", next);
  markDirty();
}

function onHandleKey(index: number, event: KeyboardEvent): void {
  const step = event.shiftKey ? 10 : 1;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const move = moves[event.key];
  if (!move) {
    if (event.key === "Enter" || event.key === " ") emit("commit");
    return;
  }
  event.preventDefault();
  nudge(index, move[0], move[1]);
}

/* ------------------------------------------------------------------ input */

function pointerDown(event: PointerEvent) {
  const p = toImage(event.clientX, event.clientY);
  const f = fit();
  if (!p || !f) return;
  const grab = TOUCH_R / f.scale;

  let nearest = -1;
  let nearestDist = Infinity;
  props.quad.forEach((c, i) => {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = i;
    }
  });

  if (nearestDist < grab) {
    drag = { kind: "corner", index: nearest };
  } else if (insidePolygon(p, props.quad)) {
    drag = { kind: "whole", start: p, origin: props.quad.map((q) => ({ ...q })) as Quad };
  } else {
    return;
  }
  canvas.value?.setPointerCapture(event.pointerId);
  event.preventDefault();
  markDirty();
}

function pointerMove(event: PointerEvent) {
  const p = toImage(event.clientX, event.clientY);
  if (!p) return;
  if (!drag) {
    const f = fit();
    if (!f) return;
    const grab = TOUCH_R / f.scale;
    const near = props.quad.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < grab);
    hovering.value = near || insidePolygon(p, props.quad);
    if (canvas.value) canvas.value.style.cursor = near ? "grab" : insidePolygon(p, props.quad) ? "move" : "default";
    return;
  }

  const clampX = (v: number) => Math.max(0, Math.min(props.src.width, v));
  const clampY = (v: number) => Math.max(0, Math.min(props.src.height, v));
  let next: Quad;

  if (drag.kind === "corner") {
    next = props.quad.map((q) => ({ ...q })) as Quad;
    next[drag.index] = { x: clampX(p.x), y: clampY(p.y) };
  } else {
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    next = drag.origin.map((q) => ({ x: clampX(q.x + dx), y: clampY(q.y + dy) })) as Quad;
  }
  emit("update:quad", next);
  markDirty();
  event.preventDefault();
}

function pointerUp(event: PointerEvent) {
  if (!drag) return;
  drag = null;
  try {
    canvas.value?.releasePointerCapture(event.pointerId);
  } catch {
    /* capture may already be gone */
  }
  markDirty();
  emit("commit");
}

/* ------------------------------------------------------------------ mount */

onMounted(() => {
  observer = new ResizeObserver(() => markDirty());
  if (host.value) observer.observe(host.value);
  markDirty();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (raf) cancelAnimationFrame(raf);
  stopSweep();
});

watch(
  () => [props.quad, props.src] as const,
  () => markDirty(),
  { deep: true }
);
</script>

<template>
  <div class="corner-editor" ref="host">
    <canvas
      ref="canvas"
      class="corner-canvas"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointercancel="pointerUp"
    />
    <!-- four real targets on top of the drawn handles: Tab reaches them,
         arrow keys nudge them, and the canvas shows which one has focus -->
    <div class="corner-handles" role="group" aria-label="Page corners">
      <button
        v-for="(pt, i) in handlePts"
        :key="i"
        class="corner-handle"
        :style="{ left: `${pt.x}px`, top: `${pt.y}px` }"
        :aria-label="`${['Top left', 'Top right', 'Bottom right', 'Bottom left'][i]} corner`"
        @focus="focused = i"
        @blur="focused = null"
        @keydown="onHandleKey(i, $event)"
      />
    </div>
  </div>
</template>
