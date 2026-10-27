import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import PagesView from "../src/components/PagesView.vue";
import { memoryStore, useProjectStore } from "../src/lib/storage";
import { addPage, scan } from "../src/lib/store";
import { installDomStubs } from "./setup";

installDomStubs();

const CARD_W = 140;
const CARD_H = 190;
const GAP = 12;
const COLS = 2;

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

/**
 * jsdom lays nothing out, and a drag is all about geometry — so the grid is
 * given a real one: two columns, fixed cards, positions from the DOM order (a
 * grid slot does not care which card sits in it).
 */
function stubGrid(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    if (!this.classList?.contains("page-card")) return rect(0, 0, 400, 600);
    const cards = Array.from(document.querySelectorAll(".page-card"));
    const i = cards.indexOf(this);
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return rect(col * (CARD_W + GAP), row * (CARD_H + GAP), CARD_W, CARD_H);
  });
}

/** Centre of the slot the given page currently occupies. */
function slotCentre(index: number): { x: number; y: number } {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    x: col * (CARD_W + GAP) + CARD_W / 2,
    y: row * (CARD_H + GAP) + CARD_H / 2,
  };
}

/** jsdom has no PointerEvent; the browser properties are what the code reads. */
function firePointer(target: EventTarget, type: string, x: number, y: number, pointerId = 1): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId });
  target.dispatchEvent(event);
}

/** Wait past the landing flight (LAND_MS + the hand-over). */
const landed = async () => {
  await tick(340);
};

const tick = async (ms = 0) => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

function order(): number[] {
  return scan.pages.map((p) => p.id);
}

async function mountGrid(count = 3): Promise<VueWrapper> {
  for (let i = 0; i < count; i++) {
    const page = addPage(new ImageData(64, 48), `page-${i + 1}`);
    page.thumb = "data:image/jpeg;base64,AAAA";
  }
  const wrapper = mount(PagesView, { attachTo: document.body });
  await tick(10);
  return wrapper;
}

/** Drag the grip of page `from` to the centre of the slot at `to`. */
async function drag(wrapper: VueWrapper, from: number, to: number) {
  const grip = wrapper.findAll(".page-grip")[from];
  const start = slotCentre(from);
  const target = slotCentre(to);
  await grip.trigger("pointerdown", { pointerId: 1, clientX: start.x, clientY: start.y });
  await grip.trigger("pointermove", {
    pointerId: 1,
    clientX: start.x + 20,
    clientY: start.y + 10,
  });
  await grip.trigger("pointermove", { pointerId: 1, clientX: target.x, clientY: target.y });
  await tick(10);
}

beforeEach(() => {
  useProjectStore(memoryStore());
  scan.pages.splice(0, scan.pages.length);
  scan.activeId = 0;
  stubGrid();
  // the grid builds a PDF when it is idle; that is not what these tests measure,
  // so the idle callback is present but never fires
  (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback = () => 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;
});

describe("reordering pages", () => {
  it("changes the order while the finger is still down", async () => {
    const wrapper = await mountGrid(3);
    const before = order();

    await drag(wrapper, 0, 2);

    // not on drop — the grid rearranges under the drag, like Google Keep
    expect(order()).toEqual([before[1], before[2], before[0]]);
    wrapper.unmount();
  });

  it("lifts the card into a preview that follows the finger", async () => {
    const wrapper = await mountGrid(3);
    await drag(wrapper, 0, 2);

    const ghost = document.querySelector<HTMLElement>(".drag-ghost");
    expect(ghost).toBeTruthy();
    // it hangs outside the grid, so it is not clipped by it
    expect(ghost!.parentElement).toBe(document.body);
    expect(ghost!.style.transform).toContain("translate3d");
    // the dragged card leaves a gap instead of showing twice
    expect(wrapper.findAll(".page-card.dragging").length).toBe(1);
    expect(wrapper.find(".page-card.dragging").classes()).toContain("dragging");
    wrapper.unmount();
  });

  it("keeps the new order and drops the preview when the finger lifts", async () => {
    const wrapper = await mountGrid(3);
    const before = order();
    await drag(wrapper, 0, 2);

    const grip = wrapper.findAll(".page-grip")[2];
    await grip.trigger("pointerup", { pointerId: 1, clientX: 300, clientY: 200 });
    await tick(10);

    expect(order()).toEqual([before[1], before[2], before[0]]);
    expect(wrapper.find(".page-card.dragging").exists()).toBe(true);

    await landed();
    expect(document.querySelector(".drag-ghost")).toBeNull();
    expect(wrapper.find(".page-card.dragging").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not reorder on a press that never travels", async () => {
    const wrapper = await mountGrid(3);
    const before = order();
    const grip = wrapper.findAll(".page-grip")[0];
    const start = slotCentre(0);
    await grip.trigger("pointerdown", { pointerId: 1, clientX: start.x, clientY: start.y });
    // a couple of pixels is still a tap: no preview, no move
    await grip.trigger("pointermove", { pointerId: 1, clientX: start.x + 2, clientY: start.y + 1 });
    await tick(5);
    expect(document.querySelector(".drag-ghost")).toBeNull();
    expect(order()).toEqual(before);

    await grip.trigger("pointerup", { pointerId: 1, clientX: start.x + 2, clientY: start.y + 1 });
    await tick(5);
    expect(order()).toEqual(before);
    wrapper.unmount();
  });

  it("keeps dragging after the grid has rearranged under it", async () => {
    const wrapper = await mountGrid(3);
    const before = order();
    await drag(wrapper, 0, 2);
    expect(order()).toEqual([before[1], before[2], before[0]]);

    // The reorder moves the card's DOM node to another slot. Pointer capture
    // does not survive that — which is why the drag hangs half way in a real
    // browser ("sobald sich die anderen verschieben, lässt es sich nicht mehr
    // ziehen"). The page listens on window instead, so a move from anywhere
    // still counts.
    const first = slotCentre(0);
    firePointer(document.body, "pointermove", first.x, first.y);
    await tick(10);

    // it went back to the first slot, which is the order we started from
    expect(order()).toEqual(before);
    // and the preview is still there, still following
    expect(document.querySelector(".drag-ghost")).toBeTruthy();

    firePointer(window, "pointerup", first.x, first.y);
    await landed();
    expect(document.querySelector(".drag-ghost")).toBeNull();
    expect(wrapper.findAll(".page-card.dragging").length).toBe(0);
    wrapper.unmount();
  });

  it("ends the drag when the browser cancels the gesture instead of hanging", async () => {
    const wrapper = await mountGrid(3);
    await drag(wrapper, 0, 2);

    firePointer(window, "pointercancel", 100, 100);
    await landed();

    // nothing stays invisible, and nothing stays armed
    expect(document.querySelector(".drag-ghost")).toBeNull();
    expect(wrapper.findAll(".page-card.dragging").length).toBe(0);

    // a new drag works immediately afterwards
    const before = order();
    await drag(wrapper, 0, 2);
    expect(order()).toEqual([before[1], before[2], before[0]]);
    wrapper.unmount();
  });

  it("does not blank the card before the drag has lifted", async () => {
    const wrapper = await mountGrid(3);
    const grip = wrapper.findAll(".page-grip")[0];
    const start = slotCentre(0);
    firePointer(grip.element, "pointerdown", start.x, start.y);

    // a press, no movement yet: the card is fully there, no preview, no hole
    expect(wrapper.findAll(".page-card.dragging").length).toBe(0);
    expect(document.querySelector(".drag-ghost")).toBeNull();
    firePointer(window, "pointerup", start.x, start.y);
    wrapper.unmount();
  });

  it("flies the held card into its slot instead of blinking there", async () => {
    const wrapper = await mountGrid(3);
    await drag(wrapper, 0, 2);
    const target = slotCentre(2);

    firePointer(window, "pointerup", target.x, target.y);
    // one frame later the flight is under way: the preview is still on screen,
    // heading for the slot, and the card itself is still the gap
    await tick(40);

    const ghost = document.querySelector<HTMLElement>(".drag-ghost");
    expect(ghost, "the preview must not vanish at the moment of the drop").toBeTruthy();
    expect(ghost!.classList.contains("landing")).toBe(true);
    // it is flying to the slot it landed in: the third card's own rectangle
    const slot = slotCentre(2);
    expect(ghost!.style.transform).toContain("translate3d");
    const heading = ghost!.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/);
    expect(heading).toBeTruthy();
    // (140x190 cards: the preview's left/top is the slot's centre minus half)
    expect(Number(heading![1])).toBeCloseTo(slot.x - 70, 0);
    expect(wrapper.findAll(".page-card.dragging").length).toBe(1);

    // and only when it has arrived does the real card take over
    await landed();
    expect(document.querySelector(".drag-ghost")).toBeNull();
    expect(wrapper.findAll(".page-card.dragging").length).toBe(0);
    wrapper.unmount();
  });

  it("hands over instantly when the phone asks for less motion", async () => {
    const real = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
    });
    try {
      const wrapper = await mountGrid(3);
      const target = slotCentre(2);
      await drag(wrapper, 0, 2);
      firePointer(window, "pointerup", target.x, target.y);
      await tick(20);
      // no flight: the preference wins, and nothing is left hanging either
      expect(document.querySelector(".drag-ghost")).toBeNull();
      expect(wrapper.findAll(".page-card.dragging").length).toBe(0);
      wrapper.unmount();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: real });
    }
  });

  it("still moves a page with the arrow keys", async () => {
    const wrapper = await mountGrid(3);
    const before = order();
    await wrapper.findAll(".page-grip")[1].trigger("keydown", { key: "ArrowLeft" });
    await tick(10);
    expect(order()).toEqual([before[1], before[0], before[2]]);
    wrapper.unmount();
  });
});
