import { describe, expect, it } from "vitest";
import { installGestureLock } from "../src/lib/gestures";

/** A touchmove with `count` fingers, dispatched on `target`. */
function touchMove(target: Element, count: number): TouchEvent {
  const event = new Event("touchmove", { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, "touches", { value: { length: count } });
  Object.defineProperty(event, "target", { value: target });
  target.dispatchEvent(event);
  return event;
}

describe("installGestureLock", () => {
  it("blocks a two-finger pinch outside the camera", () => {
    const stop = installGestureLock();
    const pages = document.createElement("div");
    document.body.append(pages);

    const event = touchMove(pages, 2);
    expect(event.defaultPrevented).toBe(true);

    stop();
    pages.remove();
  });

  it("leaves one-finger scrolling alone", () => {
    const stop = installGestureLock();
    const pages = document.createElement("div");
    document.body.append(pages);

    const event = touchMove(pages, 1);
    expect(event.defaultPrevented).toBe(false);

    stop();
    pages.remove();
  });

  it("does not swallow the pinch inside the viewfinder", () => {
    const stop = installGestureLock();
    const stage = document.createElement("div");
    stage.className = "camera-stage";
    const inner = document.createElement("div");
    stage.append(inner);
    document.body.append(stage);

    const event = touchMove(inner, 2);
    expect(event.defaultPrevented).toBe(false);

    stop();
    stage.remove();
  });

  it("blocks Safari's own gesture events", () => {
    const stop = installGestureLock();
    const pages = document.createElement("div");
    document.body.append(pages);

    const event = new Event("gesturestart", { bubbles: true, cancelable: true });
    pages.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    stop();
    pages.remove();
  });
});
