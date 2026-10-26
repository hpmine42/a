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

// Register the service worker for offline use; dev keeps a clean console.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline support is a bonus, never a blocker */
    });
  });
}
