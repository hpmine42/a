import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import App from "../src/App.vue";
import { clearPages, scan } from "../src/lib/store";
import { memoryStore, useProjectStore } from "../src/lib/storage";
import { installDomStubs } from "./setup";

installDomStubs();

/**
 * Text recognition, without the 10 MB engine.
 *
 * The engine itself (WASM, in a worker) cannot run in jsdom, and every test that
 * tried would take seconds to download it. What is worth guarding is the wiring:
 * that the button reads the page instead of the preview, that a recognised page
 * says how many words it found, that the words can be copied, and that the PDF
 * gets a word-by-word text layer in the right place. So `recognize` is mocked and
 * everything else is the real code.
 */

const fake = vi.hoisted(() => ({
  calls: [] as { width: number; height: number }[],
  fail: false as false | "engine" | "empty",
}));

vi.mock("../src/lib/ocr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ocr")>();
  return {
    ...actual,
    recognize: async (_image: unknown, size: { width: number; height: number }) => {
      if (fake.fail) throw new actual.OcrError(fake.fail);
      fake.calls.push(size);
      return {
        text: "ACME SOLUTIONS LTD.\nINVOICE 240801\n\nTOTAL DUE: 1,620.00",
        words: [
          { text: "ACME", confidence: 92, box: [0.06, 0.05, 0.16, 0.09] as [number, number, number, number] },
          { text: "INVOICE", confidence: 90, box: [0.7, 0.05, 0.9, 0.09] as [number, number, number, number] },
          { text: "1,620.00", confidence: 71, box: [0.6, 0.6, 0.8, 0.64] as [number, number, number, number] },
        ],
        confidence: 84,
        width: size.width,
        height: size.height,
        at: Date.now(),
      };
    },
  };
});

/** The sheet lives in a Teleport, i.e. outside the wrapper: query the document. */
const sheet = () => document.querySelector<HTMLElement>(".text-sheet");
const clickIn = async (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element, `${selector} must exist`).toBeTruthy();
  element!.click();
  await tick(20);
};

const tick = async (ms = 0) => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

/** A blank but valid JPEG, so the demo-photo path can decode something. */
const DEMO_JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00,
  0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0xff, 0xda, 0x00,
  0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
]);

/** Get to a finished page, the way a person does. */
async function finishedPage(wrapper: VueWrapper) {
  const demo = wrapper.findAll("button").find((b) => b.text().includes("Demo photo"));
  await demo!.trigger("click");
  await tick(300);
  const keep = wrapper.findAll("button.choice").find((b) => b.text().includes("Crop it by hand"));
  await keep!.trigger("click");
  await tick(700);
  const done = wrapper.find("button.crop-done");
  if (done.exists()) {
    await done.trigger("click");
    await tick(500);
  }
}

beforeEach(() => {
  useProjectStore(memoryStore());
  clearPages();
  fake.calls.length = 0;
  fake.fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob([DEMO_JPEG], { type: "image/jpeg" }), { status: 200 }))
  );
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob([DEMO_JPEG], { type: "image/jpeg" }), { status: 200 }))
  );
});

describe("the words on a page", () => {
  it("is offered as a quiet row under the page, and off until asked for", async () => {
    const wrapper = mount(App);
    await tick(20);
    await finishedPage(wrapper);

    const row = wrapper.find("button.text-open");
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain("Find the text");
    // nothing has been read: no engine, no words, no cost
    expect(fake.calls.length).toBe(0);
    expect(scan.pages[0].ocr).toBeNull();
    // and the dock is unchanged: Optimize and Done are still there
    expect(wrapper.find("button.optimize").exists()).toBe(true);
    expect(wrapper.find("button.done").exists()).toBe(true);
    wrapper.unmount();
  });

  it("reads the finished page, at a size the letters survive", async () => {
    const wrapper = mount(App);
    await tick(20);
    await finishedPage(wrapper);

    await wrapper.find("button.text-open").trigger("click");
    await tick(600);

    expect(fake.calls.length).toBe(1);
    // it read the *finished* page, not the photo and not a squashed thumbnail —
    // the stub photo is tiny, so the size is the page's own (see the guard in
    // project.test.ts for the real 1800px budget)
    const page0 = scan.pages[0];
    expect(fake.calls[0]).toEqual({
      width: page0.result!.width,
      height: page0.result!.height,
    });
    const page = scan.pages[0];
    expect(page.ocr?.words.length).toBe(3);
    expect(page.ocr?.text).toContain("INVOICE 240801");

    // the row now says what it found, and the sheet is open
    expect(wrapper.find("button.text-open").text()).toContain("3 words");
    expect(sheet()).toBeTruthy();
    const body = document.querySelector<HTMLTextAreaElement>(".text-body")!;
    expect(body.value).toContain("TOTAL DUE");
    wrapper.unmount();
  });

  it("keeps the page on screen exactly as sharp as it was", async () => {
    const wrapper = mount(App);
    await tick(20);
    await finishedPage(wrapper);
    const page = scan.pages[0];
    const preview = page.result!;
    const cacheKey = page.cacheKey;
    const warpedSide = page.warpedSide;

    await wrapper.find("button.text-open").trigger("click");
    await tick(600);

    // The engine reads a *copy* at its own size. Reading the words used to mean
    // rendering the page itself at 1800px, which replaced the preview with a
    // smaller one: on a phone nobody noticed, on a tablet the page went soft the
    // moment you asked for its text and nothing rendered it again.
    expect(fake.calls.length).toBe(1);
    expect(page.result).toBe(preview);
    expect(page.cacheKey).toBe(cacheKey);
    expect(page.warpedSide).toBe(warpedSide);
    expect(page.ocr?.words.length).toBe(3);
    wrapper.unmount();
  });

  it("does not run the engine twice for the same page", async () => {
    const wrapper = mount(App);
    await tick(20);
    await finishedPage(wrapper);

    await wrapper.find("button.text-open").trigger("click");
    await tick(600);
    // close the sheet, then ask again
    await clickIn(".text-sheet-top .control");
    expect(sheet()).toBeNull();

    await wrapper.find("button.text-open").trigger("click");
    await tick(200);
    expect(fake.calls.length).toBe(1);
    expect(sheet()).toBeTruthy();
    wrapper.unmount();
  });

  it("can read the page again when the first pass was poor", async () => {
    const wrapper = mount(App);
    await tick(20);
    await finishedPage(wrapper);
    await wrapper.find("button.text-open").trigger("click");
    await tick(600);
    expect(fake.calls.length).toBe(1);

    await clickIn("button.text-again");
    await tick(400);

    // a second, real pass — not a cached answer
    expect(fake.calls.length).toBe(2);
    expect(sheet()).toBeTruthy();
    wrapper.unmount();
  });

  it("copies the words, and says so", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async (text: string) => void written.push(text) },
    });
    const wrapper = mount(App);
    await tick(20);
    await finishedPage(wrapper);
    await wrapper.find("button.text-open").trigger("click");
    await tick(600);

    await clickIn("button.text-copy");
    await tick(50);

    expect(written[0]).toContain("ACME SOLUTIONS LTD.");
    expect(document.querySelector("button.text-copy")!.textContent).toContain("Copied");
    wrapper.unmount();
  });

  it("says why it failed instead of pretending the page is empty", async () => {
    fake.fail = "engine";
    const wrapper = mount(App);
    await tick(20);
    await finishedPage(wrapper);

    await wrapper.find("button.text-open").trigger("click");
    await tick(400);

    // an absent engine is a connection, not an empty page: say which
    expect(wrapper.find("button.text-open").text()).toContain("connect once");
    expect(sheet()).toBeNull();
    expect(scan.pages[0].ocr).toBeNull();
    wrapper.unmount();
  });

  it("throws the words away when the crop changes under them", async () => {
    const wrapper = mount(App);
    await tick(20);
    await finishedPage(wrapper);
    await wrapper.find("button.text-open").trigger("click");
    await tick(600);
    expect(scan.pages[0].ocr).toBeTruthy();
    await clickIn(".text-sheet-top .control");

    // a new crop moves every word on the page: boxes measured in the old one
    // would land on the wrong ink
    await wrapper.find('.editor-actions button[aria-label="Adjust the corners"]').trigger("click");
    await tick(100);
    const editor = wrapper.findComponent({ name: "CornerEditor" });
    editor.vm.$emit("update:quad", scan.pages[0].quad.map((p) => ({ x: p.x * 0.8, y: p.y * 0.8 })));
    editor.vm.$emit("commit");
    await tick(100);

    expect(scan.pages[0].ocr).toBeNull();
    wrapper.unmount();
  });
});
