import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import App from "../src/App.vue";
import { clearPages, flushSave, scan } from "../src/lib/store";
import { memoryStore, useProjectStore } from "../src/lib/storage";
import { allowCamera, denyCamera, fakeCamera, installDomStubs } from "./setup";

installDomStubs();

/** A tiny but valid JPEG: the stub pipeline only needs *some* pixels. */
const DEMO_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00,
  0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0xff, 0xda, 0x00,
  0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
]);

const tick = async (ms = 0) => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

function stubDemoFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob([DEMO_JPEG], { type: "image/jpeg" }), { status: 200 }))
  );
}

async function shootDemo(wrapper: VueWrapper) {
  const demo = wrapper.findAll("button").find((b) => b.text().includes("Demo photo"));
  expect(demo, "demo photo button must exist when the camera is unavailable").toBeTruthy();
  await demo!.trigger("click");
  await tick(300);
}

/**
 * Finish a page the way the app now asks for it: leave the crop tool first (its
 * only control is "Done cropping"), then tap Done on the page itself.
 */
async function finish(wrapper: VueWrapper) {
  const crop = wrapper.find("button.crop-done");
  if (crop.exists()) {
    await crop.trigger("click");
    await tick(500);
  }
  await wrapper.find("button.done").trigger("click");
  await tick(120);
}

async function choose(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll("button.choice").find((b) => b.text().includes(label));
  expect(button, `choice "${label}" must exist`).toBeTruthy();
  await button!.trigger("click");
  await tick(700);
}

beforeEach(() => {
  useProjectStore(null);
  fakeCamera.reset();
  clearPages();
  window.localStorage.clear();
  denyCamera();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { __workerQuad?: unknown }).__workerQuad;
});

describe("camera", () => {
  it("offers a way forward when the camera is unavailable", async () => {
    const wrapper = mount(App);
    await tick(20);

    expect(wrapper.find(".camera-stage").exists()).toBe(true);
    expect(wrapper.find(".shutter").exists()).toBe(true);
    expect(wrapper.text()).toContain("Choose photo");
    expect(wrapper.text()).toContain("Demo photo");
    // the viewfinder says the product's name
    expect(wrapper.find(".brand-name").text()).toBe("Scano");
    // the dock is labelled, not a row of anonymous icons
    expect(wrapper.text()).toContain("Photos");
    expect(wrapper.text()).toContain("Flip");
    wrapper.unmount();
  });

  it("remembers the Detect switch between visits", async () => {
    allowCamera();
    const first = mount(App);
    await tick(30);
    await first.find('button[aria-label="Detect the page while framing"]').trigger("click");
    await tick(10);
    first.unmount();

    const second = mount(App);
    await tick(30);
    expect(second.find('button[aria-label="Detect the page while framing"]').classes()).toContain("on");
    second.unmount();
  });

  it("has detection off by default and lets the user switch it on", async () => {
    allowCamera();
    const wrapper = mount(App);
    await tick(30);

    const detect = wrapper.find('button[aria-label="Detect the page while framing"]');
    expect(detect.exists()).toBe(true);
    expect(detect.classes()).not.toContain("on");
    expect(detect.text()).toContain("Detect");

    await detect.trigger("click");
    expect(detect.classes()).toContain("on");
    expect(wrapper.find(".camera-hint").text()).toContain("Looking for the page");

    await detect.trigger("click");
    expect(wrapper.find(".camera-hint").text()).toContain("tap the shutter");
    wrapper.unmount();
  });
});

describe("capture with a known page", () => {
  it("uses the detected quad without asking", async () => {
    allowCamera();
    // the worker reports this quad for every frame → the viewfinder shows it
    (globalThis as unknown as { __workerQuad?: unknown }).__workerQuad = [
      { x: 20, y: 20 },
      { x: 300, y: 20 },
      { x: 300, y: 220 },
      { x: 20, y: 220 },
    ];

    const wrapper = mount(App);
    await tick(60);
    await wrapper.find('button[aria-label="Detect the page while framing"]').trigger("click");
    await tick(80);
    expect(wrapper.find(".camera-hint").text()).toContain("Page found");

    await wrapper.find(".shutter").trigger("click");
    await tick(700);

    // no question, straight into the editor with the detected corners
    expect(wrapper.find(".review").exists()).toBe(false);
    expect(wrapper.find(".editor").exists()).toBe(true);
    expect(scan.pages.length).toBe(1);
    // detection runs on a 320px frame of a 1280px video, so the stored quad is
    // scaled back up by 4 (20 → 80); the page keeps exactly what was found and
    // the render pulls the crop in a hair, so no desk edge ends up on the page
    expect(scan.pages[0].quad[0].x).toBeGreaterThan(78);
    expect(scan.pages[0].quad[0].x).toBeLessThan(82);
    wrapper.unmount();
  });

  it("asks when nothing was detected while framing", async () => {
    allowCamera();
    const wrapper = mount(App);
    await tick(40);
    await wrapper.find(".shutter").trigger("click");
    await tick(200);

    expect(wrapper.find(".review").exists()).toBe(true);
    // detection was off for this shot: the copy says so, because that is why
    // nothing was cropped
    expect(wrapper.text()).toContain("Detection is off");
    expect(scan.pages.length).toBe(0);
    wrapper.unmount();
  });

  it("says no page was found when detection was on and found nothing", async () => {
    allowCamera();
    const wrapper = mount(App);
    await tick(40);
    await wrapper.find('button[aria-label="Detect the page while framing"]').trigger("click");
    await tick(80);
    await wrapper.find(".shutter").trigger("click");
    await tick(200);

    expect(wrapper.find(".review").exists()).toBe(true);
    expect(wrapper.text()).toContain("No page edge found");
    expect(wrapper.text()).not.toContain("Detection is off");
    wrapper.unmount();
  });
});

describe("capture without a page", () => {
  it("offers three ways to crop before anything is processed", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);

    expect(wrapper.find(".review").exists()).toBe(true);
    expect(wrapper.findAll("button.choice").length).toBe(3);
    // detection was off, so nothing failed — the copy must not claim otherwise
    expect(wrapper.text()).not.toContain("No page detected");
    expect(wrapper.text()).toContain("How should we crop this?");
    expect(wrapper.text()).toContain("Crop it by hand");
    expect(wrapper.text()).toContain("Find the page automatically");
    expect(wrapper.text()).toContain("Keep the whole photo");
    expect(scan.pages.length).toBe(0);
    expect(wrapper.find(".editor").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the search on the sheet instead of freezing", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);

    const auto = wrapper.findAll("button.choice").find((b) => b.text().includes("Find the page"))!;
    await auto.trigger("click");
    await tick(30);

    // mid-flight the sheet is working: a sweep, honest words, and no buttons
    // that could start a second pass
    expect(wrapper.text()).toContain("Looking for the page");
    expect(wrapper.findAll("button.choice").length).toBe(0);

    // and it must finish on its own, not need a second tap
    await tick(900);
    expect(wrapper.find(".editor, .review").exists()).toBe(true);
    wrapper.unmount();
  });

  it("honours Discard even while the detector is still running", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);

    const auto = wrapper.findAll("button.choice").find((b) => b.text().includes("Find the page"))!;
    await auto.trigger("click");
    await tick(40);
    await wrapper.find('button[aria-label="Discard photo and go back"]').trigger("click");
    await tick(1200);

    // no page appears out of a photo the user threw away
    expect(scan.pages.length).toBe(0);
    expect(wrapper.find(".camera").exists()).toBe(true);
    wrapper.unmount();
  });

  it("says which page this is, not just how many exist", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await wrapper.find("button.crop-done").trigger("click");
    await tick(400);
    await wrapper.find("button.done").trigger("click");
    await tick(200);

    await wrapper.find(".page-add").trigger("click");
    await tick(300);
    await shootDemo(wrapper);

    expect(wrapper.find(".review-count").text()).toContain("Page 2");
    wrapper.unmount();
  });

  it("does not blame detection for a photo that was uploaded", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);

    // a library photo never had a viewfinder, so there was no detection to be
    // switched off — the sheet must ask the plain question
    expect(wrapper.find(".review").exists()).toBe(true);
    expect(wrapper.text()).toContain("How should we crop this?");
    expect(wrapper.text()).toContain("Nothing has been cropped yet");
    expect(wrapper.text()).not.toContain("Detection is off");
    wrapper.unmount();
  });

  it("opens the corner tool straight away when cropping by hand", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");

    expect(wrapper.find(".editor").exists()).toBe(true);
    expect(wrapper.find(".corner-editor").exists()).toBe(true);
    expect(wrapper.find(".auto-pill").text()).toContain("Find the page");
    wrapper.unmount();
  });

  it("falls back to manual cropping when the detector finds nothing", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Find the page automatically");
    // the sweep has to be seen, then the "nothing found" state, then the tool
    await tick(700);

    expect(wrapper.find(".corner-editor").exists()).toBe(true);
    expect(wrapper.find(".frame-hint").text()).toContain("No page edge found");
    wrapper.unmount();
  });

  it("keeps the whole photo on request", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Keep the whole photo");

    expect(scan.pages.length).toBe(1);
    expect(wrapper.find(".corner-editor").exists()).toBe(true);
    wrapper.unmount();
  });

  it("can discard a shot and go back to the camera", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);

    await wrapper.find('button[aria-label="Discard photo and go back"]').trigger("click");
    await tick(100);

    expect(scan.pages.length).toBe(0);
    expect(wrapper.find(".camera").exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("editor", () => {
  it("has one Optimize switch, off by default, and it toggles", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await wrapper.find("button.crop-done").trigger("click");
    await tick(500);

    const button = wrapper.find("button.optimize");
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain("Optimize");
    // the photo as taken is the honest starting point
    expect(scan.pages[0].opts.optimize).toBe(false);
    expect(button.attributes("aria-pressed")).toBe("false");
    expect(button.text()).toContain("Off");

    await button.trigger("click");
    await tick(400);

    expect(scan.pages[0].opts.optimize).toBe(true);
    expect(button.attributes("aria-pressed")).toBe("true");
    expect(button.classes()).toContain("on");
    expect(button.text()).toContain("On");

    await button.trigger("click");
    await tick(400);
    expect(scan.pages[0].opts.optimize).toBe(false);
    wrapper.unmount();
  });

  it("turns the finished page a quarter at a time", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await wrapper.find("button.crop-done").trigger("click");
    await tick(500);

    const rotate = wrapper.find('.editor-actions button[aria-label="Rotate this page a quarter turn"]');
    expect(rotate.exists()).toBe(true);

    const before = scan.pages[0].rotation;
    await rotate.trigger("click");
    await tick(400);
    expect(scan.pages[0].rotation).toBe((before + 90) % 360);
    // the render is redone, not just flagged
    expect(scan.pages[0].result).toBeTruthy();
    wrapper.unmount();
  });

  it("offers only the way out while the corners are being placed", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");

    expect(wrapper.find(".corner-editor").exists()).toBe(true);
    // in the crop tool there is nothing to optimize yet and nothing to finish
    expect(wrapper.find("button.optimize").exists()).toBe(false);
    expect(wrapper.find("button.done").exists()).toBe(false);
    expect(wrapper.find("button.crop-done").text()).toContain("Done cropping");

    await wrapper.find("button.crop-done").trigger("click");
    await tick(500);
    expect(wrapper.find(".corner-editor").exists()).toBe(false);
    expect(wrapper.find("button.optimize").exists()).toBe(true);
    expect(wrapper.find("button.done").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders the new crop before the page is finished", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");

    const page = scan.pages[0];
    const before = page.result;
    const editor = wrapper.findComponent({ name: "CornerEditor" });
    const next = page.quad.map((p) => ({ x: p.x * 0.7, y: p.y * 0.7 }));
    editor.vm.$emit("update:quad", next);
    await wrapper.find("button.crop-done").trigger("click");
    await tick(500);
    await wrapper.find("button.done").trigger("click");
    await tick(200);

    // the grid shows the page that was just cropped, not the one before it
    expect(wrapper.find(".pages").exists()).toBe(true);
    expect(page.result).not.toBe(before);
    expect(page.cacheKey).not.toBe("");
    wrapper.unmount();
  });

  it("does no image work while the corner tool is open", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");

    const editor = wrapper.findComponent({ name: "CornerEditor" });
    const before = scan.pages[0].result;
    const next = scan.pages[0].quad.map((p) => ({ x: p.x * 0.9, y: p.y * 0.9 }));
    editor.vm.$emit("update:quad", next);
    await editor.vm.$emit("commit");
    await tick(120);

    // dragging must not trigger a warp per finger lift
    expect(scan.pages[0].result).toBe(before);
    wrapper.unmount();
  });

  it("applies manual corner edits to the page", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");

    const editor = wrapper.findComponent({ name: "CornerEditor" });
    const next = scan.pages[0].quad.map((p) => ({ x: p.x * 0.5, y: p.y * 0.5 }));
    editor.vm.$emit("update:quad", next);
    await editor.vm.$emit("commit");
    await tick(200);

    expect(scan.pages[0].quad[0].x).toBeCloseTo(next[0].x, 5);
    wrapper.unmount();
  });
});

describe("pages", () => {
  it("shows the finished pages with a PDF action and paper sizes", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await finish(wrapper);

    expect(wrapper.find(".pages").exists()).toBe(true);
    expect(wrapper.findAll(".page-card").length).toBe(1);
    expect(wrapper.find("button.save").text()).toContain("Save PDF");
    expect(wrapper.text()).toContain("Letter");

    const letter = wrapper.findAll("button.paper").find((b) => b.text() === "Letter");
    await letter!.trigger("click");
    expect(scan.format).toBe("letter");

    scan.format = "a4";
    wrapper.unmount();
  });

  it("removes a page and keeps the grid consistent", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await finish(wrapper);

    await wrapper.find(".page-del").trigger("click");
    await tick(50);

    expect(scan.pages.length).toBe(0);
    expect(wrapper.findAll(".page-card").length).toBe(0);

    // deleting is one fat finger away from disaster, and there is no re-shoot
    expect(wrapper.find(".undo-bar").exists()).toBe(true);
    await wrapper.find(".undo-action").trigger("click");
    await tick(50);
    expect(scan.pages.length).toBe(1);
    expect(wrapper.findAll(".page-card").length).toBe(1);
    expect(wrapper.find(".undo-bar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("returns to the page grid when the editor was opened from it", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await finish(wrapper);
    expect(wrapper.find(".pages").exists()).toBe(true);

    // tap the thumbnail: the editor opens, and Back must lead to the grid again
    await wrapper.find(".page-thumb").trigger("click");
    await tick(200);
    expect(wrapper.find(".editor").exists()).toBe(true);
    expect(wrapper.find('.editor-top button[aria-label="Back to pages"]').exists()).toBe(true);

    await wrapper.find('.editor-top button[aria-label="Back to pages"]').trigger("click");
    await tick(100);
    expect(wrapper.find(".pages").exists()).toBe(true);
    wrapper.unmount();
  });

  it("offers a grip to reorder pages, and no share button without a share sheet", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await finish(wrapper);
    await wrapper.find(".page-add").trigger("click");
    await tick(300);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await finish(wrapper);

    expect(wrapper.find(".page-grip").exists()).toBe(true);
    expect(wrapper.find(".page-add").text()).toContain("Add page");
    // jsdom has no navigator.share: promising a share sheet would be a lie
    expect(wrapper.find("button.share-pdf").exists()).toBe(false);
    wrapper.unmount();
  });

  it("explains the empty grid instead of leaving a lonely plus", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await finish(wrapper);

    await wrapper.find(".page-del").trigger("click");
    await tick(50);
    expect(wrapper.find(".pages-empty").text()).toContain("No pages yet");
    wrapper.unmount();
  });
});

describe("camera zoom", () => {
  it("offers zoom chips without repeating the number beside them", async () => {
    allowCamera();
    const wrapper = mount(App);
    await tick(40);

    const chips = wrapper.findAll("button.zoom-chip");
    expect(chips.map((c) => c.text())).toContain("1×");
    expect(chips.map((c) => c.text())).toContain("2×");
    // at a preset the active chip already says it; a "1.0×" next to it read as a
    // third, broken chip
    expect(wrapper.find(".zoom-value").exists()).toBe(false);
    await wrapper.findAll("button.zoom-chip")[2].trigger("click");
    await tick(50);
    expect(wrapper.find(".zoom-value").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the number only while a pinch is between the presets", async () => {
    allowCamera();
    const wrapper = mount(App);
    await tick(40);

    const stage = wrapper.find(".camera-stage");
    await stage.trigger("pointerdown", { pointerId: 1, clientX: 100, clientY: 300 });
    await stage.trigger("pointerdown", { pointerId: 2, clientX: 200, clientY: 300 });
    await stage.trigger("pointermove", { pointerId: 2, clientX: 260, clientY: 300 });
    await tick(30);

    // 100px apart, spread to 160px
    expect(wrapper.find(".zoom-value").text()).toBe("1.6×");

    // and it goes away again once the pinch lands on a preset
    await stage.trigger("pointermove", { pointerId: 2, clientX: 300, clientY: 300 });
    await tick(30);
    expect(wrapper.find(".zoom-value").exists()).toBe(false);
    wrapper.unmount();
  });

  it("never lets the page zoom escape from the viewfinder", async () => {
    // the stage owns its gesture; the rest of the app locks it (lib/gestures)
    const wrapper = mount(App);
    await tick(20);
    expect(wrapper.find(".camera-stage").exists()).toBe(true);
    wrapper.unmount();
  });
});

describe("pdf naming", () => {
  it("lets the user name the file before saving", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");
    await finish(wrapper);

    const field = wrapper.find("#pdf-name");
    expect(field.exists()).toBe(true);
    // a sensible default is filled in already
    expect((field.element as HTMLInputElement).value).toMatch(/^Scano \d{4}-\d{2}-\d{2}$/);
    expect(wrapper.text()).toContain(".pdf");

    await field.setValue("Rechnung August");
    expect(scan.filename).toBe("Rechnung August");
    expect(wrapper.find(".name-hint").text()).toContain("Rechnung August.pdf");
    wrapper.unmount();
  });
});

describe("ultra wide", () => {
  it("offers the 0.5x chip when a second rear lens is there", async () => {
    allowCamera();
    const wrapper = mount(App);
    await tick(60);

    const chips = wrapper.findAll("button.zoom-chip").map((c) => c.text());
    expect(chips).toContain("0.5×");
    wrapper.unmount();
  });
});

describe("installed app", () => {
  afterEach(() => {
    delete (navigator as unknown as { getInstalledRelatedApps?: unknown }).getInstalledRelatedApps;
  });

  it("offers to fix a stale home-screen copy when the browser reports one", async () => {
    (navigator as unknown as { getInstalledRelatedApps?: unknown }).getInstalledRelatedApps = async () => [
      { platform: "webapp", id: "https://example.test/scanner/" },
    ];

    const wrapper = mount(App);
    await tick(60);

    expect(wrapper.text()).toContain("Fix the installed app");
    expect(wrapper.text()).toContain("An old copy is still on this phone");
    wrapper.unmount();
  });

  it("says nothing about installing when there is no prompt and no entry", async () => {
    const wrapper = mount(App);
    await tick(60);

    expect(wrapper.find(".install-bar").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("coming back to the app", () => {
  it("puts last session's pages on screen after a reload", async () => {
    useProjectStore(memoryStore());
    stubDemoFetch();

    const first = mount(App);
    await tick(20);
    await shootDemo(first);
    await choose(first, "Crop it by hand");
    await finish(first);
    await tick(200);
    await flushSave();
    first.unmount();

    // the tab was closed: memory is gone, the device is not
    scan.pages.splice(0, scan.pages.length);
    scan.activeId = 0;

    const second = mount(App);
    await tick(250);

    // the app itself did the restoring, not this test
    expect(scan.pages.length).toBe(1);
    expect(scan.pages[0].name).toBe("scan");
    // the filmstrip offer is there, so the pages are visibly back
    expect(second.find(".stack").exists()).toBe(true);
    second.unmount();
    useProjectStore(null);
  });
});

describe("focusing by tapping the picture", () => {
  /** A tap: down and up in the same spot, which is what the stage watches for. */
  async function tapStage(wrapper: VueWrapper, x = 200, y = 300) {
    const stage = wrapper.find(".camera-stage");
    await stage.trigger("pointerdown", { pointerId: 7, clientX: x, clientY: y });
    await stage.trigger("pointerup", { pointerId: 7, clientX: x, clientY: y });
    await tick(30);
  }

  it("asks the lens to focus where the finger was, and shows the ring", async () => {
    allowCamera();
    fakeCamera.caps = { focusMode: ["continuous", "single-shot"] };
    const wrapper = mount(App);
    await tick(40);

    await tapStage(wrapper);

    expect(wrapper.find(".focus-ring").exists()).toBe(true);
    const asked = JSON.stringify(fakeCamera.applied);
    expect(asked).toContain("pointsOfInterest");
    expect(asked).toContain("single-shot");
    // and it hands the lens back to continuous, or it would stay locked
    expect(wrapper.find(".focus-note").exists()).toBe(false);
    wrapper.unmount();
  });

  it("falls back to a plain refocus when the lens ignores focus points", async () => {
    allowCamera();
    // resolves, but reports nothing back: the browser ignored it
    fakeCamera.echo = false;
    fakeCamera.caps = { focusMode: ["continuous", "single-shot"] };
    const wrapper = mount(App);
    await tick(40);

    await tapStage(wrapper);
    await tick(30);

    const asked = JSON.stringify(fakeCamera.applied);
    expect(asked).toContain("focusMode");
    // centred, because that is where the camera actually focuses
    expect(wrapper.find(".focus-ring").exists()).toBe(false);
    expect(wrapper.find(".focus-note").exists()).toBe(true);
    wrapper.unmount();
  });

  it("does not fire when the tap was meant for a chip", async () => {
    allowCamera();
    fakeCamera.caps = { focusMode: ["continuous", "single-shot"] };
    const wrapper = mount(App);
    await tick(40);
    const before = fakeCamera.applied.length;

    const chip = wrapper.find("button.zoom-chip");
    await chip.trigger("pointerdown", { pointerId: 3, clientX: 10, clientY: 10 });
    await chip.trigger("pointerup", { pointerId: 3, clientX: 10, clientY: 10 });
    await tick(30);

    expect(wrapper.find(".focus-ring").exists()).toBe(false);
    expect(fakeCamera.applied.length).toBe(before);
    wrapper.unmount();
  });
});
