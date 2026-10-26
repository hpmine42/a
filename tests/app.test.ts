import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
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

async function openDemoPhoto(wrapper: VueWrapper) {
  const demo = wrapper.findAll("button").find((b) => b.text().includes("Demo photo"));
  expect(demo, "demo photo button must exist when the camera is unavailable").toBeTruthy();
  await demo!.trigger("click");
  await tick(700);
}

beforeEach(() => {
  clearPages();
  denyCamera();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("camera", () => {
  it("offers a way forward when the camera is unavailable", async () => {
    const wrapper = mount(App);
    await tick(20);

    expect(wrapper.find(".camera-stage").exists()).toBe(true);
    expect(wrapper.find(".shutter").exists()).toBe(true);
    expect(wrapper.text()).toContain("Choose photo");
    expect(wrapper.text()).toContain("Demo photo");
    expect(wrapper.find(".camera-hint").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the detection toggle only when a stream is live, on by default", async () => {
    const off = mount(App);
    await tick(20);
    expect(off.find('button[aria-label="Automatic page detection"]').exists()).toBe(false);
    off.unmount();

    allowCamera();

    const wrapper = mount(App);
    await tick(30);
    const autoButton = wrapper.find('button[aria-label="Automatic page detection"]');
    expect(autoButton.exists()).toBe(true);
    expect(autoButton.classes()).toContain("on");

    await autoButton.trigger("click");
    expect(autoButton.classes()).not.toContain("on");
    expect(wrapper.find(".camera-hint").text()).toContain("Detection off");
    wrapper.unmount();
  });
});

describe("capture flow", () => {
  it("turns a photo into a page and opens the editor", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await openDemoPhoto(wrapper);

    expect(scan.pages.length).toBe(1);
    expect(wrapper.find(".editor").exists()).toBe(true);
    // nothing detectable in the stub image, so the manual frame tool opens itself
    expect(wrapper.find(".corner-editor").exists()).toBe(true);
    expect(wrapper.find(".auto-pill").exists()).toBe(true);
    wrapper.unmount();
  });

  it("switches the look from the dock and keeps the choice on the page", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await openDemoPhoto(wrapper);

    const gray = wrapper.find("button.swatch.gray");
    expect(gray.exists()).toBe(true);
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
    await openDemoPhoto(wrapper);

    const editor = wrapper.findComponent({ name: "CornerEditor" });
    expect(editor.exists()).toBe(true);
    const next = scan.pages[0].quad.map((p) => ({ x: p.x * 0.5, y: p.y * 0.5 }));
    editor.vm.$emit("update:quad", next);
    await editor.vm.$emit("commit");
    await tick(200);

    expect(scan.pages[0].quad[0].x).toBeCloseTo(next[0].x, 5);
    wrapper.unmount();
  });

  it("shows the finished pages with a PDF action", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await openDemoPhoto(wrapper);

    const done = wrapper.find("button.done");
    expect(done.exists()).toBe(true);
    await done.trigger("click");
    await tick(100);

    expect(wrapper.find(".pages").exists()).toBe(true);
    expect(wrapper.findAll(".page-card").length).toBe(1);
    expect(wrapper.find("button.save").text()).toContain("Save PDF");
    wrapper.unmount();
  });

  it("removes a page and keeps the grid consistent", async () => {
    stubDemoFetch();
    const wrapper = mount(App);
    await tick(20);
    await openDemoPhoto(wrapper);
    await wrapper.find("button.done").trigger("click");
    await tick(100);

    await wrapper.find(".page-del").trigger("click");
    await tick(50);

    expect(scan.pages.length).toBe(0);
    expect(wrapper.findAll(".page-card").length).toBe(0);
    wrapper.unmount();
  });
});
