import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import App from "../src/App.vue";
import { clearPages, scan } from "../src/lib/store";
import { allowCamera, denyCamera, installDomStubs } from "./setup";

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

async function choose(wrapper: VueWrapper, label: string) {
  const button = wrapper.findAll("button.choice").find((b) => b.text().includes(label));
  expect(button, `choice "${label}" must exist`).toBeTruthy();
  await button!.trigger("click");
  await tick(700);
}

beforeEach(() => {
  clearPages();
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
    // scaled back up by 4 (20 → 80) and then pulled in a hair, so no desk edge
    // ends up on the finished page
    expect(scan.pages[0].quad[0].x).toBeGreaterThan(80);
    expect(scan.pages[0].quad[0].x).toBeLessThan(92);
    wrapper.unmount();
  });

  it("asks when nothing was detected while framing", async () => {
    allowCamera();
    const wrapper = mount(App);
    await tick(40);
    await wrapper.find(".shutter").trigger("click");
    await tick(200);

    expect(wrapper.find(".review").exists()).toBe(true);
    expect(scan.pages.length).toBe(0);
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

  it("opens the corner tool straight away when cropping by hand", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");

    expect(wrapper.find(".editor").exists()).toBe(true);
    expect(wrapper.find(".corner-editor").exists()).toBe(true);
    expect(wrapper.find(".auto-pill").text()).toContain("Detect page");
    wrapper.unmount();
  });

  it("falls back to manual cropping when the detector finds nothing", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Find the page automatically");

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
  it("switches the look from the labelled dock", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await shootDemo(wrapper);
    await choose(wrapper, "Crop it by hand");

    const looks = wrapper.findAll("button.look");
    expect(looks.length).toBe(3);
    expect(looks.map((l) => l.text())).toEqual(["B/W", "Grey", "Colour"]);
    // a plain segmented control: text only, no thumbnail hunt
    expect(wrapper.findAll("button.look img")).toHaveLength(0);

    const gray = wrapper.find("button.look.gray");
    await gray.trigger("click");
    await tick(200);

    expect(scan.pages[0].opts.mode).toBe("gray");
    expect(gray.classes()).toContain("active");
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
    await wrapper.find("button.done").trigger("click");
    await tick(100);

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
    await wrapper.find("button.done").trigger("click");
    await tick(100);

    await wrapper.find(".page-del").trigger("click");
    await tick(50);

    expect(scan.pages.length).toBe(0);
    expect(wrapper.findAll(".page-card").length).toBe(0);
    wrapper.unmount();
  });
});

describe("camera zoom", () => {
  it("offers zoom chips and reports the current zoom", async () => {
    allowCamera();
    const wrapper = mount(App);
    await tick(40);

    const chips = wrapper.findAll("button.zoom-chip");
    expect(chips.map((c) => c.text())).toContain("1×");
    expect(chips.map((c) => c.text())).toContain("2×");
    expect(wrapper.find(".zoom-value").text()).toBe("1.0×");
    // pressing a chip is how the lens moves without the pinch gesture
    await wrapper.findAll("button.zoom-chip")[2].trigger("click");
    await tick(50);
    expect(wrapper.find(".zoom-value").text()).toBe("2.0×");
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
    await wrapper.find("button.done").trigger("click");
    await tick(100);

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
