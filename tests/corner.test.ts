import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import CornerEditor from "../src/components/CornerEditor.vue";
import type { Quad } from "../src/lib/cv";
import { toView } from "../src/lib/orient";
import { installDomStubs } from "./setup";

installDomStubs();

/**
 * The crop tool draws on a canvas, so "where is a corner" is only visible in the
 * DOM through the buttons that sit on top of the handles. That is exactly what
 * these tests read — a person dragging a corner is seeing those positions.
 */
const BOX = { left: 0, top: 0, width: 400, height: 600 };
const rect = { ...BOX, right: BOX.width, bottom: BOX.height, x: 0, y: 0, toJSON: () => ({}) };

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    rect as unknown as DOMRect
  );
  HTMLCanvasElement.prototype.setPointerCapture = () => undefined;
  HTMLCanvasElement.prototype.releasePointerCapture = () => undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A page filling a 240x320 photo, all four corners on the frame. */
const FULL: Quad = [
  { x: 0, y: 0 },
  { x: 240, y: 0 },
  { x: 240, y: 320 },
  { x: 0, y: 320 },
];

async function mountTool(rotation: number) {
  const wrapper = mount(CornerEditor, {
    props: { src: new ImageData(240, 320), quad: FULL, rotation },
  });
  // the canvas is painted on the next frame; the handles appear with it
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await flushPromises();
  return wrapper;
}

function handles(wrapper: VueWrapper): { left: number; top: number }[] {
  return wrapper.findAll("button.corner-handle").map((b) => {
    const style = (b.element as HTMLElement).style;
    return { left: parseFloat(style.left), top: parseFloat(style.top) };
  });
}

function quad(wrapper: VueWrapper): Quad {
  return wrapper.emitted("update:quad")?.at(-1)?.[0] as Quad;
}

describe("the crop tool and a turned page", () => {
  it("draws an upright photo exactly where the page is", async () => {
    const wrapper = await mountTool(0);
    // 240x320 into 400x600 → width-limited: 400x533, centred at y=33.3
    const seen = handles(wrapper);
    const want = [
      [0, 33.33],
      [400, 33.33],
      [400, 566.67],
      [0, 566.67],
    ];
    want.forEach(([left, top], i) => {
      expect(seen[i].left).toBeCloseTo(left, 1);
      expect(seen[i].top).toBeCloseTo(top, 1);
    });
    wrapper.unmount();
  });

  it("turns the photo with the page instead of showing it sideways again", async () => {
    const wrapper = await mountTool(90);
    // 320x240 into 400x600 → scale 1.25, centred: 400x300 at y=150
    expect(handles(wrapper)).toEqual([
      { left: 0, top: 150 },
      { left: 400, top: 150 },
      { left: 400, top: 450 },
      { left: 0, top: 450 },
    ]);
    wrapper.unmount();
  });

  it("writes a dragged corner back into the photo's own pixels", async () => {
    const wrapper = await mountTool(90);
    // grab the on-screen top-left, which is the photo's bottom-left corner
    await wrapper.find("canvas.corner-canvas").trigger("pointerdown", {
      pointerId: 1,
      clientX: 2,
      clientY: 152,
    });
    await wrapper.find("canvas.corner-canvas").trigger("pointermove", {
      pointerId: 1,
      clientX: 60,
      clientY: 400,
    });

    const next = quad(wrapper);
    expect(next).toBeTruthy();
    // screen (60, 400) → view pixel (48, 200) → photo pixel (200, 272)
    expect(next[3].x).toBeCloseTo(200, 0);
    expect(next[3].y).toBeCloseTo(272, 0);
    // and the other three are untouched
    expect(next[0]).toEqual(FULL[0]);
    expect(next[1]).toEqual(FULL[1]);
    expect(next[2]).toEqual(FULL[2]);
    wrapper.unmount();
  });

  it("puts the handles where the view says they are on a half turn", async () => {
    const wrapper = await mountTool(180);
    const seen = handles(wrapper);
    // 180°: the on-screen top left is the photo's bottom-right corner
    const expected = toView({ x: 240, y: 320 }, 2, 240, 320);
    const scale = 400 / 240;
    const dy = (600 - 320 * scale) / 2;
    expect(seen[0].left).toBeCloseTo(expected.x * scale, 1);
    expect(seen[0].top).toBeCloseTo(dy + expected.y * scale, 1);
    wrapper.unmount();
  });
});
