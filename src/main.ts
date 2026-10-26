import { jsPDF } from "jspdf";
import "./style.css";
import {
  detectPageQuad,
  enhance,
  fullFrameQuad,
  outputSize,
  warp,
  type EnhanceOpts,
  type Mode,
  type Pt,
  type Quad,
} from "./cv";

/* ---------------------------------------------------------------- types */

type Opts = Required<EnhanceOpts>;

type Page = {
  id: number;
  name: string;
  src: ImageData;
  quad: Quad;
  warped: ImageData | null;
  result: ImageData | null;
  thumb: string | null;
  opts: Opts;
};

const PREVIEW_MAX = 2000;
const EXPORT_MAX = 2600;

const state = {
  pages: [] as Page[],
  activeId: null as number | null,
  view: "result" as "result" | "original",
  nextId: 1,
};

const defaultOpts = (): Opts => ({ mode: "bw", brightness: 0, contrast: 0, strength: 55 });

/* ---------------------------------------------------------------- dom */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const els = {
  empty: $("#empty"),
  dropzone: $("#dropzone"),
  editor: $("#editor"),
  stage: $("#stage"),
  srcCanvas: $<HTMLCanvasElement>("#srcCanvas"),
  overlay: $<HTMLCanvasElement>("#overlay"),
  preview: $<HTMLCanvasElement>("#preview"),
  busy: $("#busy"),
  resLabel: $("#resLabel"),
  status: $("#status"),
  filmstrip: $("#filmstrip"),
  fileInput: $<HTMLInputElement>("#fileInput"),
  cameraInput: $<HTMLInputElement>("#cameraInput"),
  exportPdf: $<HTMLButtonElement>("#exportPdf"),
  addMore: $("#addMore"),
  clearAll: $("#clearAll"),
  strength: $<HTMLInputElement>("#strength"),
  brightness: $<HTMLInputElement>("#brightness"),
  contrast: $<HTMLInputElement>("#contrast"),
  strengthField: $("#strengthField"),
};

const ctxSrc = els.srcCanvas.getContext("2d")!;
const ctxOverlay = els.overlay.getContext("2d")!;
const ctxPreview = els.preview.getContext("2d")!;

const active = () => state.pages.find((p) => p.id === state.activeId) ?? null;

/* ---------------------------------------------------------------- loading */

function imageDataFromBitmap(bmp: ImageBitmap, maxSide: number): ImageData {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

async function addFiles(files: File[] | FileList) {
  const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
  if (!list.length) {
    setStatus("Those files are not images.", true);
    return;
  }
  setStatus(`Loading ${list.length} photo${list.length > 1 ? "s" : ""}…`);
  for (const file of list) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const src = imageDataFromBitmap(bmp, 2600);
      bmp.close?.();
      const detected = safeDetect(src);
      const page: Page = {
        id: state.nextId++,
        name: file.name.replace(/\.[^.]+$/, ""),
        src,
        quad: detected ?? fullFrameQuad(src.width, src.height),
        warped: null,
        result: null,
        thumb: null,
        opts: defaultOpts(),
      };
      state.pages.push(page);
      state.activeId = page.id;
    } catch (err) {
      console.error(err);
      setStatus(`Could not read “${file.name}”.`, true);
    }
  }
  render();
  await processActive({ full: true });
  setStatus(`${state.pages.length} page${state.pages.length > 1 ? "s" : ""} ready`);
}

function safeDetect(img: ImageData): Quad | null {
  try {
    return detectPageQuad(img);
  } catch (err) {
    console.warn("detection failed", err);
    return null;
  }
}

/* ---------------------------------------------------------------- rendering */

function render() {
  const hasPages = state.pages.length > 0;
  els.empty.hidden = hasPages;
  els.editor.hidden = !hasPages;
  els.filmstrip.hidden = !hasPages;
  els.exportPdf.disabled = !hasPages;
  els.addMore.hidden = !hasPages;
  els.clearAll.hidden = !hasPages;

  if (!hasPages) return;
  drawSource();
  drawOverlay();
  syncControls();
  renderFilmstrip();
  drawPreview();
}

function drawSource() {
  const page = active();
  if (!page) return;
  els.srcCanvas.width = page.src.width;
  els.srcCanvas.height = page.src.height;
  ctxSrc.putImageData(page.src, 0, 0);
  sizeOverlay();
}

function sizeOverlay() {
  const page = active();
  if (!page) return;
  const rect = els.srcCanvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  els.overlay.style.width = `${rect.width}px`;
  els.overlay.style.height = `${rect.height}px`;
  els.overlay.width = Math.round(rect.width * dpr);
  els.overlay.height = Math.round(rect.height * dpr);
  ctxOverlay.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const HANDLE_R = 9;

function drawOverlay() {
  const page = active();
  if (!page || !els.overlay.width) return;
  const rect = els.srcCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const sx = w / page.src.width;
  const sy = h / page.src.height;
  const pts = page.quad.map((p) => ({ x: p.x * sx, y: p.y * sy }));

  ctxOverlay.clearRect(0, 0, w, h);

  // dim everything outside the quad
  ctxOverlay.save();
  ctxOverlay.beginPath();
  ctxOverlay.rect(0, 0, w, h);
  ctxOverlay.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctxOverlay.lineTo(pts[i].x, pts[i].y);
  ctxOverlay.closePath();
  ctxOverlay.fillStyle = "rgba(6, 8, 11, 0.62)";
  ctxOverlay.fill("evenodd");
  ctxOverlay.restore();

  // quad outline
  ctxOverlay.beginPath();
  ctxOverlay.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctxOverlay.lineTo(pts[i].x, pts[i].y);
  ctxOverlay.closePath();
  ctxOverlay.strokeStyle = "rgba(255, 184, 107, 0.95)";
  ctxOverlay.lineWidth = 1.75;
  ctxOverlay.stroke();

  // third lines, subtle guides
  ctxOverlay.save();
  ctxOverlay.setLineDash([4, 5]);
  ctxOverlay.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctxOverlay.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const t = i / 3;
    ctxOverlay.beginPath();
    ctxOverlay.moveTo(pts[0].x + (pts[3].x - pts[0].x) * t, pts[0].y + (pts[3].y - pts[0].y) * t);
    ctxOverlay.lineTo(pts[1].x + (pts[2].x - pts[1].x) * t, pts[1].y + (pts[2].y - pts[1].y) * t);
    ctxOverlay.stroke();
    ctxOverlay.beginPath();
    ctxOverlay.moveTo(pts[0].x + (pts[1].x - pts[0].x) * t, pts[0].y + (pts[1].y - pts[0].y) * t);
    ctxOverlay.lineTo(pts[3].x + (pts[2].x - pts[3].x) * t, pts[3].y + (pts[2].y - pts[3].y) * t);
    ctxOverlay.stroke();
  }
  ctxOverlay.restore();

  // handles
  for (const p of pts) {
    ctxOverlay.beginPath();
    ctxOverlay.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
    ctxOverlay.fillStyle = "rgba(12, 14, 18, 0.85)";
    ctxOverlay.fill();
    ctxOverlay.lineWidth = 2.5;
    ctxOverlay.strokeStyle = "#ffb86b";
    ctxOverlay.stroke();
    ctxOverlay.beginPath();
    ctxOverlay.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctxOverlay.fillStyle = "#ffb86b";
    ctxOverlay.fill();
  }
}

function renderFilmstrip() {
  const list = els.filmstrip;
  list.innerHTML = "";
  state.pages.forEach((page, i) => {
    const btn = document.createElement("button");
    btn.className = `thumb${page.id === state.activeId ? " active" : ""}`;
    btn.title = `${page.name} — page ${i + 1}`;
    const img = document.createElement("img");
    img.alt = "";
    if (page.thumb) img.src = page.thumb;
    btn.appendChild(img);
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = String(i + 1);
    btn.appendChild(num);
    const del = document.createElement("span");
    del.className = "del";
    del.textContent = "×";
    del.setAttribute("role", "button");
    del.title = "Remove page";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removePage(page.id);
    });
    btn.appendChild(del);
    btn.addEventListener("click", () => {
      if (page.id === state.activeId) return;
      state.activeId = page.id;
      render();
      processActive({ full: true });
    });
    list.appendChild(btn);
  });

  const add = document.createElement("button");
  add.className = "add-tile";
  add.textContent = "+";
  add.title = "Add photos";
  add.addEventListener("click", () => els.fileInput.click());
  list.appendChild(add);
}

function drawPreview() {
  const page = active();
  if (!page) return;
  const img = state.view === "original" ? page.warped : page.result;
  if (!img) return;
  els.preview.width = img.width;
  els.preview.height = img.height;
  ctxPreview.putImageData(img, 0, 0);
  const long = Math.max(img.width, img.height);
  els.resLabel.textContent = `${img.width} × ${img.height} · export ${Math.round(
    (EXPORT_MAX / long) * 100
  )}%`;
}

function setStatus(msg: string, isError = false) {
  els.status.textContent = msg;
  els.status.style.color = isError ? "var(--danger)" : "var(--muted)";
}

/* ---------------------------------------------------------------- processing */

let jobToken = 0;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function processActive(opts: { full: boolean; warp?: boolean }) {
  const page = active();
  if (!page) return;
  const token = ++jobToken;
  els.busy.hidden = false;
  await nextFrame();
  if (token !== jobToken) return;

  const maxSide = opts.full ? PREVIEW_MAX : 900;
  try {
    if (!page.warped || opts.warp) {
      const size = outputSize(page.quad, maxSide);
      page.warped = warp(page.src, page.quad, size.w, size.h);
    }
    page.result = enhance(page.warped, page.opts);
    if (token !== jobToken) return;
    drawPreview();
    if (opts.full) {
      page.thumb = makeThumb(page.result);
      renderFilmstrip();
    }
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong while processing this page.", true);
  } finally {
    if (token === jobToken) els.busy.hidden = true;
  }
}

function makeThumb(img: ImageData): string {
  const targetW = 62 * 2;
  const targetH = 78 * 2;
  const scale = Math.min(targetW / img.width, targetH / img.height);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const tmp = document.createElement("canvas");
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tmp, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.7);
}

let sliderTimer: number | undefined;
function scheduleQuick() {
  window.clearTimeout(sliderTimer);
  sliderTimer = window.setTimeout(() => processActive({ full: true }), 90);
}

/* ---------------------------------------------------------------- controls */

function syncControls() {
  const page = active();
  if (!page) return;
  const o = page.opts;
  els.strength.value = String(o.strength);
  els.brightness.value = String(o.brightness);
  els.contrast.value = String(o.contrast);
  ($("#strengthOut") as HTMLElement).textContent = String(o.strength);
  ($("#brightnessOut") as HTMLElement).textContent = String(o.brightness);
  ($("#contrastOut") as HTMLElement).textContent = String(o.contrast);
  els.strengthField.style.opacity = o.mode === "bw" ? "1" : "0.35";
  document.querySelectorAll<HTMLElement>("#modeSeg .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === o.mode);
  });
  document.querySelectorAll<HTMLElement>("#viewSeg .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.view);
  });
}

function updateOpts(patch: Partial<Opts>) {
  const page = active();
  if (!page) return;
  Object.assign(page.opts, patch);
  syncControls();
  scheduleQuick();
}

document.querySelectorAll<HTMLElement>("#modeSeg .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => updateOpts({ mode: btn.dataset.mode as Mode }));
});

document.querySelectorAll<HTMLElement>("#viewSeg .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.view = btn.dataset.view as "result" | "original";
    syncControls();
    drawPreview();
  });
});

els.strength.addEventListener("input", () => updateOpts({ strength: Number(els.strength.value) }));
els.brightness.addEventListener("input", () => updateOpts({ brightness: Number(els.brightness.value) }));
els.contrast.addEventListener("input", () => updateOpts({ contrast: Number(els.contrast.value) }));

$("#applyAll").addEventListener("click", () => {
  const page = active();
  if (!page) return;
  for (const p of state.pages) p.opts = { ...page.opts };
  setStatus("Settings applied to all pages");
});

$("#removePage").addEventListener("click", () => {
  if (state.activeId) removePage(state.activeId);
});

function removePage(id: number) {
  const i = state.pages.findIndex((p) => p.id === id);
  if (i === -1) return;
  state.pages.splice(i, 1);
  if (state.activeId === id) {
    state.activeId = state.pages[Math.min(i, state.pages.length - 1)]?.id ?? null;
  }
  if (!state.pages.length) {
    jobToken++;
    setStatus("");
  }
  render();
  if (state.pages.length) processActive({ full: true });
}

$("#detect").addEventListener("click", () => {
  const page = active();
  if (!page) return;
  const quad = safeDetect(page.src);
  if (quad) {
    page.quad = quad;
    page.warped = null;
    drawOverlay();
    processActive({ full: true, warp: true });
    setStatus("Corners detected");
  } else {
    setStatus("No clear page edge found — drag the corners yourself.", true);
  }
});

$("#resetQuad").addEventListener("click", () => {
  const page = active();
  if (!page) return;
  page.quad = fullFrameQuad(page.src.width, page.src.height);
  page.warped = null;
  drawOverlay();
  processActive({ full: true, warp: true });
});

els.addMore.addEventListener("click", () => els.fileInput.click());
els.clearAll.addEventListener("click", () => {
  state.pages = [];
  state.activeId = null;
  jobToken++;
  setStatus("");
  render();
});

/* ---------------------------------------------------------------- corner dragging */

type DragState =
  | { kind: "corner"; index: number }
  | { kind: "whole"; start: Pt; quad: Quad }
  | null;

let drag: DragState = null;

function toImageCoords(e: PointerEvent): Pt | null {
  const page = active();
  if (!page) return null;
  const rect = els.overlay.getBoundingClientRect();
  if (!rect.width) return null;
  return {
    x: ((e.clientX - rect.left) / rect.width) * page.src.width,
    y: ((e.clientY - rect.top) / rect.height) * page.src.height,
  };
}

function insidePolygon(pt: Pt, quad: Quad): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = quad[i];
    const b = quad[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

els.overlay.style.pointerEvents = "auto";
els.overlay.style.cursor = "crosshair";

els.overlay.addEventListener("pointerdown", (e) => {
  const page = active();
  const pt = toImageCoords(e);
  if (!page || !pt) return;
  const rect = els.overlay.getBoundingClientRect();
  const pickRadius = (22 / Math.max(1, rect.width)) * page.src.width;

  let nearest = -1;
  let nearestDist = Infinity;
  page.quad.forEach((c, i) => {
    const d = Math.hypot(c.x - pt.x, c.y - pt.y);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = i;
    }
  });

  if (nearestDist < pickRadius) {
    drag = { kind: "corner", index: nearest };
  } else if (insidePolygon(pt, page.quad)) {
    drag = { kind: "whole", start: pt, quad: page.quad.map((p) => ({ ...p })) as Quad };
  } else {
    return;
  }
  els.overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
});

els.overlay.addEventListener("pointermove", (e) => {
  const page = active();
  const pt = toImageCoords(e);
  if (!page || !pt) return;

  if (!drag) {
    // hover affordance only
    const rect = els.overlay.getBoundingClientRect();
    const pickRadius = (22 / Math.max(1, rect.width)) * page.src.width;
    const near = page.quad.some((c) => Math.hypot(c.x - pt.x, c.y - pt.y) < pickRadius);
    els.overlay.style.cursor = near ? "grab" : insidePolygon(pt, page.quad) ? "move" : "crosshair";
    return;
  }

  const clampX = (v: number) => Math.max(0, Math.min(page.src.width, v));
  const clampY = (v: number) => Math.max(0, Math.min(page.src.height, v));

  if (drag.kind === "corner") {
    page.quad[drag.index] = { x: clampX(pt.x), y: clampY(pt.y) };
  } else {
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    page.quad = drag.quad.map((p) => ({
      x: clampX(p.x + dx),
      y: clampY(p.y + dy),
    })) as Quad;
  }
  page.warped = null;
  drawOverlay();
  scheduleQuick();
});

async function endDrag(e: PointerEvent) {
  if (!drag) return;
  drag = null;
  try {
    els.overlay.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  await processActive({ full: true, warp: true });
}

els.overlay.addEventListener("pointerup", endDrag);
els.overlay.addEventListener("pointercancel", endDrag);

/* ---------------------------------------------------------------- file inputs / drop / paste */

$("#pickFiles").addEventListener("click", (e) => {
  e.stopPropagation();
  els.fileInput.click();
});
$("#useCamera").addEventListener("click", (e) => {
  e.stopPropagation();
  els.cameraInput.click();
});
$("#useSample").addEventListener("click", async (e) => {
  e.stopPropagation();
  setStatus("Loading demo photo…");
  try {
    const res = await fetch("samples/letter.jpg");
    const blob = await res.blob();
    await addFiles([new File([blob], "demo-invoice.jpg", { type: blob.type || "image/jpeg" })]);
  } catch {
    setStatus("Demo photo is missing.", true);
  }
});

els.dropzone.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});

els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files?.length) addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.cameraInput.addEventListener("change", () => {
  if (els.cameraInput.files?.length) addFiles(els.cameraInput.files);
  els.cameraInput.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  els.dropzone.classList.add("dragover");
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropzone.classList.remove("dragover");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

window.addEventListener("paste", (e) => {
  const files: File[] = [];
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) addFiles(files);
});

/* ---------------------------------------------------------------- export */

function imageDataToCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}

function exportImage(page: Page): ImageData {
  const size = outputSize(page.quad, EXPORT_MAX);
  const warped = warp(page.src, page.quad, size.w, size.h);
  return enhance(warped, page.opts);
}

els.exportPdf.addEventListener("click", async () => {
  if (!state.pages.length) return;
  const btn = els.exportPdf;
  btn.disabled = true;
  setStatus("Building PDF…");
  await nextFrame();
  try {
    let doc: jsPDF | null = null;
    for (let i = 0; i < state.pages.length; i++) {
      const page = state.pages[i];
      setStatus(`Building PDF… page ${i + 1}/${state.pages.length}`);
      await nextFrame();
      const img = exportImage(page);
      const canvas = imageDataToCanvas(img);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      const landscape = img.width > img.height;
      if (!doc) {
        doc = new jsPDF({
          unit: "mm",
          format: "a4",
          orientation: landscape ? "landscape" : "portrait",
          compress: true,
        });
      } else {
        doc.addPage("a4", landscape ? "landscape" : "portrait");
      }
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      const ratio = img.width / img.height;
      let w = pw;
      let h = pw / ratio;
      if (h > ph) {
        h = ph;
        w = ph * ratio;
      }
      doc.addImage(dataUrl, "JPEG", (pw - w) / 2, (ph - h) / 2, w, h, undefined, "FAST");
    }
    if (doc) {
      const name = state.pages.length === 1 ? `${slug(state.pages[0].name)}.pdf` : "scan.pdf";
      doc.save(name);
      setStatus(`Saved ${name}`);
    }
  } catch (err) {
    console.error(err);
    setStatus("PDF export failed.", true);
  } finally {
    btn.disabled = false;
  }
});

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "scan"
  );
}

/* ---------------------------------------------------------------- resize */

const ro = new ResizeObserver(() => {
  if (!state.pages.length) return;
  sizeOverlay();
  drawOverlay();
});
ro.observe(els.stage);
window.addEventListener("resize", () => {
  if (!state.pages.length) return;
  sizeOverlay();
  drawOverlay();
});

/* ---------------------------------------------------------------- boot */

render();
setStatus("");
