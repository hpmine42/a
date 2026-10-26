<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Pt, Quad } from "../lib/cv";
import { canvasFor, containFit } from "../lib/image";

const props = defineProps<{ src: ImageData; quad: Quad }>();
const emit = defineEmits<{
  (e: "update:quad", quad: Quad): void;
  (e: "commit"): void;
}>();

const host = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const hovering = ref(false);

let ctx: CanvasRenderingContext2D | null = null;
let observer: ResizeObserver | null = null;
let raf = 0;
let dirty = true;

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
  return {
    x: (clientX - rect.left - f.dx) / f.scale,
    y: (clientY - rect.top - f.dy) / f.scale,
  };
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

  // handles
  pts.forEach((p, i) => {
    const active = drag?.kind === "corner" && drag.index === i;
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
    drawLoupe(pts[drag.index], pts[drag.index], f.scale, w, h);
  }
}

function drawLoupe(anchor: Pt, handle: Pt, scale: number, w: number, h: number) {
  const g = ctx;
  if (!g) return;
  const R = 52;
  const zoom = 2.4;
  // keep the loupe inside the stage and away from the finger
  let cx = handle.x + (handle.x > w * 0.5 ? -R - 34 : R + 34);
  let cy = handle.y + (handle.y > h * 0.5 ? -R - 26 : R + 26);
  cx = Math.max(R + 8, Math.min(w - R - 8, cx));
  cy = Math.max(R + 8, Math.min(h - R - 8, cy));

  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.closePath();
  g.clip();
  g.fillStyle = "#0a0b0d";
  g.fillRect(cx - R, cy - R, R * 2, R * 2);

  const src = canvasFor(props.src);
  const ix = anchor.x / scale;
  const iy = anchor.y / scale;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, ix - R / zoom, iy - R / zoom, (R * 2) / zoom, (R * 2) / zoom, cx - R, cy - R, R * 2, R * 2);

  // reticle
  g.strokeStyle = "rgba(255, 192, 97, 0.9)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(cx - 10, cy);
  g.lineTo(cx + 10, cy);
  g.moveTo(cx, cy - 10);
  g.lineTo(cx, cy + 10);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, 14, 0, Math.PI * 2);
  g.strokeStyle = "rgba(255, 255, 255, 0.5)";
  g.stroke();
  g.restore();

  // ring
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.lineWidth = 2;
  g.strokeStyle = "rgba(255, 192, 97, 0.95)";
  g.stroke();
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
  </div>
</template>
