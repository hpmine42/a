import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import CaptureReview from "../src/components/CaptureReview.vue";
import { SWEEP_MS } from "../src/lib/anim";
import { detectPageQuadsAsync, disposeDetectWorker } from "../src/lib/detect-async";
import { installDomStubs } from "./setup";

installDomStubs();

const tick = async (ms = 0) => {
  await flushPromises();
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

const photo = () => new ImageData(120, 160);

function mountReview(props: Record<string, unknown>) {
  return mount(CaptureReview, {
    props: {
      src: photo(),
      pageCount: 0,
      detectionOn: true,
      ...props,
    },
  });
}

describe("the amber band", () => {
  it("reports the end of its pass only after it has travelled the photo", async () => {
    const wrapper = mountReview({ phase: "searching" });
    await tick(50);
    expect(wrapper.emitted("swept")).toBeUndefined();

    await tick(SWEEP_MS + 120);
    const events = wrapper.emitted("swept");
    expect(events?.length).toBe(1);
    wrapper.unmount();
  });

  it("stops animating once the pass is over", async () => {
    const wrapper = mountReview({ phase: "searching" });
    await tick(SWEEP_MS + 200);
    const frames = requestAnimationFrame as unknown as { mock?: unknown };
    void frames;
    // the loop stops itself: waiting again adds no further events
    await tick(400);
    expect(wrapper.emitted("swept")?.length).toBe(1);
    wrapper.unmount();
  });

  it("does not announce anything when no search is running", async () => {
    const wrapper = mountReview({ phase: "idle" });
    await tick(SWEEP_MS + 120);
    expect(wrapper.emitted("swept")).toBeUndefined();
    wrapper.unmount();
  });
});

describe("detection off the main thread", () => {
  const globals = globalThis as unknown as { __workerQuads?: unknown; Worker?: unknown };

  beforeEach(() => {
    globals.__workerQuads = [];
    disposeDetectWorker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globals.__workerQuads = [];
  });

  it("returns what the worker found", async () => {
    const quad = [
      { x: 10, y: 12 },
      { x: 100, y: 14 },
      { x: 98, y: 150 },
      { x: 12, y: 148 },
    ];
    globals.__workerQuads = [quad];
    await expect(detectPageQuadsAsync(photo())).resolves.toEqual([quad]);
  });

  it("returns an empty answer — not null — when the worker finds nothing", async () => {
    globals.__workerQuads = [];
    await expect(detectPageQuadsAsync(photo())).resolves.toEqual([]);
  });

  it("says so when there is no worker at all, so the caller can do it inline", async () => {
    disposeDetectWorker();
    vi.stubGlobal("Worker", undefined);
    await expect(detectPageQuadsAsync(photo())).resolves.toBeNull();
  });
});
