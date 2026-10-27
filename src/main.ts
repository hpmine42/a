import { createApp } from "vue";
import App from "./App.vue";
import { applyViewportFit, watchViewportFit } from "./lib/fit";
import { installGestureLock } from "./lib/gestures";
import "./styles.css";

// Before the first paint: a phone in desktop-site mode renders the app at ~40%.
applyViewportFit();
watchViewportFit();
// pinch belongs to the camera only (see lib/gestures.ts)
installGestureLock();

createApp(App).mount("#app");

// index.html shows a small "opening the scanner" mark until the app is alive;
// dropping it here is what makes a blank screen mean "the bundle did not run".
document.getElementById("boot")?.remove();

/**
 * Register the service worker: this is what makes the app open with no network.
 *
 * `updateViaCache: "none"` matters more than it looks. GitHub Pages serves
 * `sw.js` with a ten minute HTTP cache; without this the browser can spend that
 * window running an old worker against a new `index.html` — the one combination
 * that produces a blank app. The worker precaches a whole build (see
 * vite.config.ts), so once this has run once, the app is genuinely offline.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const start = () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: "none" })
      .catch(() => {
        /* offline support is a bonus, never a blocker */
      });
  };
  // after load, so the first visit is not competing with the precache
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}
