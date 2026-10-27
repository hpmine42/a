import { beforeEach, describe, expect, it } from "vitest";
import { fakeCanvas, installDomStubs } from "./setup";
import { memoryStore, useProjectStore } from "../src/lib/storage";
import {
  addPage,
  clearPages,
  ensureSource,
  flushSave,
  movePage,
  removePage,
  restoreProject,
  rotatePage,
  scan,
  scheduleSave,
  type Page,
} from "../src/lib/store";
import { rotateImageData } from "../src/lib/image";
import { safeCanvasSize } from "../src/lib/pdf";

installDomStubs();

const photo = () => new ImageData(64, 48);

/** Simulate a launch: drop everything in memory, keep the "disk". */
function closeApp() {
  scan.pages.splice(0, scan.pages.length);
  scan.activeId = 0;
  scan.filename = "";
}

beforeEach(async () => {
  useProjectStore(memoryStore());
  closeApp();
  scan.format = "a4";
});

describe("rotation", () => {
  it("turns a quarter turn clockwise without losing a row", () => {
    const img = new ImageData(2, 1);
    // red, green
    img.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
    const turned = rotateImageData(img, 1);
    expect(turned.width).toBe(1);
    expect(turned.height).toBe(2);
    // clockwise: the left pixel ends up on top
    expect([...turned.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...turned.data.slice(4, 8)]).toEqual([0, 255, 0, 255]);
  });

  it("is identity at zero and reversible four times", () => {
    const img = new ImageData(3, 2);
    for (let i = 0; i < img.data.length; i++) img.data[i] = i % 256;
    expect(rotateImageData(img, 0)).toBe(img);
    let turned = img;
    for (let i = 0; i < 4; i++) turned = rotateImageData(turned, 1);
    expect([...turned.data]).toEqual([...img.data]);
  });

  it("marks the page and drops the stale render", () => {
    const page = addPage(photo(), "scan");
    page.result = photo();
    page.cacheKey = "1:orig:0";
    rotatePage(page);
    expect(page.rotation).toBe(90);
    expect(page.result).toBeNull();
  });
});

describe("saving and restoring a project", () => {
  it("brings back pages, order, crop, look and file name", async () => {
    const a = addPage(photo(), "receipt");
    const b = addPage(photo(), "letter");
    a.quad = [
      { x: 4, y: 5 },
      { x: 40, y: 3 },
      { x: 42, y: 44 },
      { x: 2, y: 45 },
    ];
    b.opts.optimize = true;
    b.whole = true;
    rotatePage(b);
    scan.filename = "Steuer 2025";
    scan.format = "letter";
    scheduleSave(a);
    scheduleSave(b);
    scheduleSave();
    await flushSave();

    closeApp();
    const count = await restoreProject();

    expect(count).toBe(2);
    expect(scan.pages.map((p) => p.name)).toEqual(["receipt", "letter"]);
    expect(scan.pages[0].quad[0]).toEqual({ x: 4, y: 5 });
    expect(scan.pages[1].rotation).toBe(90);
    // "keep the whole photo" survives a reload: the page must not sprout the
    // hairline inset again just because the app was closed
    expect(scan.pages[1].whole).toBe(true);
    expect(scan.pages[1].opts.optimize).toBe(true);
    expect(scan.filename).toBe("Steuer 2025");
    expect(scan.format).toBe("letter");
    expect(scan.activeId).toBe(scan.pages[1].id);
  });

  it("hands the photo back lazily, so launch stays instant", async () => {
    addPage(photo(), "scan");
    scheduleSave(scan.pages[0]);
    await flushSave();
    closeApp();
    await restoreProject();

    const page = scan.pages[0];
    expect(page.src.width).toBe(1);
    await ensureSource(page);
    // the stubbed decoder returns 240x320
    expect(page.src.width).toBe(240);
    expect(page.src.height).toBe(320);
  });

  it("keeps a page dirty until its photo is actually on disk", async () => {
    // a full disk or a private window can refuse one encode; the page must not
    // be forgotten because of it, or it survives the session and disappears on
    // the next launch with nothing to see in between
    const page = addPage(photo(), "scan");
    scheduleSave(page);
    fakeCanvas.blank = true;
    await flushSave();
    closeApp();
    expect(await restoreProject()).toBe(0);
    scan.pages.splice(0, scan.pages.length);

    // the page is still in memory, still waiting to be written
    scan.pages.push(page);
    fakeCanvas.blank = false;
    await flushSave();
    closeApp();
    expect(await restoreProject()).toBe(1);
  });

  it("keeps the order the user dragged the pages into", async () => {
    addPage(photo());
    addPage(photo());
    addPage(photo());
    for (const page of scan.pages as Page[]) scheduleSave(page);
    movePage(0, 2);
    const moved = scan.pages.map((p) => p.id);
    await flushSave();
    closeApp();
    await restoreProject();
    expect(scan.pages.map((p) => p.id)).toEqual(moved);
  });

  it("forgets a page that was deleted, even after a reload", async () => {
    const a = addPage(photo());
    addPage(photo());
    for (const p of scan.pages) scheduleSave(p);
    await flushSave();
    removePage(a.id);
    await flushSave();
    closeApp();
    expect(await restoreProject()).toBe(1);
  });

  it("never overwrites a stored photo with the undecoded placeholder", async () => {
    const page = addPage(photo());
    scheduleSave(page);
    await flushSave();
    closeApp();
    await restoreProject();

    const restored = scan.pages[0];
    expect(restored.pending).toBeTruthy();
    // rotating a page whose pixels are still in flight used to write `src:null`
    rotatePage(restored);
    scheduleSave(restored);
    await flushSave();

    closeApp();
    expect(await restoreProject()).toBe(1);
    const again = scan.pages[0];
    expect(again.srcBlob).toBeTruthy();
    await ensureSource(again);
    expect(again.src.width).toBe(240);
  });

  it("never replaces a stored photo with a page that has none", async () => {
    const page = addPage(photo());
    scheduleSave(page);
    await flushSave();
    expect(await restoreProject()).toBe(1);

    // A record written by an older build, without the photo it needs
    const bare = {
      id: 99,
      name: "scan",
      quad: page.quad,
      rotation: 0,
      optimize: false,
      thumb: null,
      src: null,
    };
    // writing straight to the store is what a previous version did
    const fake = memoryStore();
    await fake.writePage(bare as never);
    useProjectStore(fake);

    // such a page cannot be opened or exported, so it is not restored at all
    closeApp();
    expect(await restoreProject()).toBe(0);
  });

  it("does nothing at all without a store", async () => {
    useProjectStore(null);
    addPage(photo());
    scheduleSave(scan.pages[0]);
    await flushSave();
    closeApp();
    expect(await restoreProject()).toBe(0);
  });
});

describe("export size guard", () => {
  it("leaves a normal page alone", () => {
    expect(safeCanvasSize(2400, 3200)).toEqual({ w: 2400, h: 3200 });
  });

  it("shrinks a page that would exceed what Safari will draw", () => {
    const size = safeCanvasSize(6000, 5000);
    expect(size.w * size.h).toBeLessThanOrEqual(8_000_000);
    expect(Math.max(size.w, size.h)).toBeLessThanOrEqual(4096);
    // and it keeps the aspect ratio, or the page would look stretched
    expect(size.w / size.h).toBeCloseTo(6000 / 5000, 2);
  });
});

describe("clear pages", () => {
  it("wipes the stored project too", async () => {
    const page = addPage(photo());
    scheduleSave(page);
    await flushSave();
    clearPages();
    expect(await restoreProject()).toBe(0);
  });
});
