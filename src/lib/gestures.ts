/* Pinch-to-zoom belongs to the camera, nowhere else.
 *
 * Outside the viewfinder a two-finger pinch only ever fights the user: it
 * zooms the app chrome, leaves the layout half-scaled, and on iOS it also
 * survives `user-scalable=no`. So the gesture is swallowed here — but only
 * outside `.camera-stage`, where the camera component runs its own pinch to
 * drive the lens.
 */

const CAMERA = ".camera-stage";

function insideCamera(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return Boolean(el?.closest?.(CAMERA));
}

function block(event: Event): void {
  if (event.cancelable) event.preventDefault();
}

export function installGestureLock(doc: Document = document): () => void {
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length > 1 && !insideCamera(event.target)) block(event);
  };
  // Safari fires these for its own page zoom
  const onGesture = (event: Event) => {
    if (!insideCamera(event.target)) block(event);
  };
  const onWheel = (event: WheelEvent) => {
    // ctrl+wheel is browser zoom on desktop, which looks identical to breakage
    if (event.ctrlKey && !insideCamera(event.target)) block(event);
  };

  doc.addEventListener("touchmove", onTouchMove, { passive: false });
  doc.addEventListener("gesturestart", onGesture, { passive: false } as AddEventListenerOptions);
  doc.addEventListener("gesturechange", onGesture, { passive: false } as AddEventListenerOptions);
  doc.addEventListener("gestureend", onGesture, { passive: false } as AddEventListenerOptions);
  doc.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    doc.removeEventListener("touchmove", onTouchMove);
    doc.removeEventListener("gesturestart", onGesture);
    doc.removeEventListener("gesturechange", onGesture);
    doc.removeEventListener("gestureend", onGesture);
    doc.removeEventListener("wheel", onWheel);
  };
}
