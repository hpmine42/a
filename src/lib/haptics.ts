/**
 * A short tap of haptic feedback, where the platform has any.
 *
 * Android browsers expose `navigator.vibrate`; iOS Safari does not, and a phone
 * may ignore the call for any reason at all. Every path here is therefore
 * optional and failure is silent — feedback is a bonus, never a requirement.
 */

const supported = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

function buzz(pattern: number | number[]): void {
  if (!supported()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* permission, policy, or a browser that lies about the API */
  }
}

/** A control was pressed: barely perceptible, like a mechanical key. */
export function tap(): void {
  buzz(6);
}

/** The shutter, or another action that produced something. */
export function thump(): void {
  buzz(12);
}

/** A small confirmation: the switch moved, the page changed. */
export function click(): void {
  buzz([4, 24, 6]);
}
