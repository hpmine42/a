import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import EditorView from "../src/components/EditorView.vue";
import { addPage, clearPages } from "../src/lib/store";
import { memoryStore, useProjectStore } from "../src/lib/storage";
import { installDomStubs } from "./setup";

installDomStubs();

/**
 * How much room the finished page actually gets.
 *
 * jsdom lays nothing out, so the numbers are handed in: a 390x700 stage that
 * pads 20px per side, exactly like `.editor-stage` in the stylesheet. The page
 * has to fit into what the padding *leaves*, not into the stage's outer box —
 * that box includes the breathing room the design asked for.
 */

const STAGE = { width: 390, height: 700 };
const PAD = 20;
const CONTENT = { w: STAGE.width - PAD * 2, h: STAGE.height - PAD * 2 };

const tick = async (ms = 0) => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

beforeEach(() => {
  useProjectStore(memoryStore());
  clearPages();
  vi.restoreAllMocks();

  // every element reports the stage's box; the component only asks about the
  // stage, and a canvas that reports a size lets the draw path run at all
  const rect = {
    width: STAGE.width,
    height: STAGE.height,
    left: 0,
    top: 0,
    right: STAGE.width,
    bottom: STAGE.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);

  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    paddingLeft: `${PAD}px`,
    paddingRight: `${PAD}px`,
    paddingTop: `${PAD}px`,
    paddingBottom: `${PAD}px`,
  } as unknown as CSSStyleDeclaration);
});

/** A finished page: 240x320 pixels on screen, rendered at its own size. */
function finishedPage() {
  const src = new ImageData(240, 320);
  const page = addPage(src, "scan");
  page.result = new ImageData(240, 320);
  page.warpedSide = 320;
  page.thumb = "data:image/jpeg;base64,AAAA";
  return page;
}

const sizeOf = (el: HTMLElement) => ({
  w: parseFloat(el.style.width),
  h: parseFloat(el.style.height),
});

describe("the page in its stage", () => {
  it("keeps the stage's breathing room instead of spilling into it", async () => {
    finishedPage();
    const wrapper = mount(EditorView, { props: { initialMode: "result" } });
    await tick(120);

    const canvas = wrapper.find<HTMLCanvasElement>("canvas.paper-canvas").element;
    const size = sizeOf(canvas);

    expect(size.w).toBeGreaterThan(200);
    expect(size.w).toBeLessThanOrEqual(CONTENT.w);
    expect(size.h).toBeLessThanOrEqual(CONTENT.h);
    // a portrait page is limited by the width here, so it fills it exactly
    expect(size.w).toBeCloseTo(CONTENT.w, 0);
    wrapper.unmount();
  });

  it("follows the padding when the UI is scaled up, instead of being clipped", async () => {
    // a browser in desktop-site mode: --u makes every size token bigger, the
    // stage pads more, and a constant that ignored it cut the page's edges off
    const big = 2.4;
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      paddingLeft: `${PAD * big}px`,
      paddingRight: `${PAD * big}px`,
      paddingTop: `${PAD * big}px`,
      paddingBottom: `${PAD * big}px`,
    } as unknown as CSSStyleDeclaration);

    finishedPage();
    const wrapper = mount(EditorView, { props: { initialMode: "result" } });
    await tick(120);

    const canvas = wrapper.find<HTMLCanvasElement>("canvas.paper-canvas").element;
    const size = sizeOf(canvas);
    expect(size.w).toBeLessThanOrEqual(STAGE.width - PAD * big * 2);
    expect(size.h).toBeLessThanOrEqual(STAGE.height - PAD * big * 2);
    wrapper.unmount();
  });

  it("renders at least the pixels it shows, without doubling them", async () => {
    const page = finishedPage();
    const wrapper = mount(EditorView, { props: { initialMode: "result" } });
    await tick(120);
    const size = sizeOf(wrapper.find<HTMLCanvasElement>("canvas.paper-canvas").element);
    // the page is rendered for the box it will be shown in, not for the stage's
    // long side: sharp at 1:1, and nowhere near a 2x waste of memory
    expect(page.warpedSide).toBeGreaterThanOrEqual(Math.round(size.h));
    expect(page.warpedSide).toBeLessThanOrEqual(Math.round(size.h * 2));
    wrapper.unmount();
  });
});
