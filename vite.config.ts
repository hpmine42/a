import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * Stamp the service worker with the build it belongs to.
 *
 * A cache name is the only way a service worker can promise "this deploy, not
 * the one from three weeks ago" — and a version someone has to remember to bump
 * is a version that goes stale. The stamp is written into the built copy only;
 * the source keeps the placeholder.
 */
function stampServiceWorker(): Plugin {
  return {
    name: "scano:stamp-sw",
    apply: "build",
    closeBundle() {
      const file = resolve(__dirname, "dist/sw.js");
      try {
        const source = readFileSync(file, "utf8");
        if (!source.includes("__BUILD__")) return;
        const build = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
        writeFileSync(file, source.replace(/__BUILD__/g, build));
      } catch {
        /* not having a service worker is not a reason to fail a build */
      }
    },
  };
}

export default defineConfig({
  // Relative base on purpose: the build has to work at "/", at "/<repo>/" on
  // GitHub Pages and under a renamed repo or custom domain without a rebuild.
  // An absolute base is the classic reason a Pages deploy shows a blank page —
  // index.html loads, then every asset under /assets/... 404s.
  base: "./",
  plugins: [vue(), stampServiceWorker()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // the sandbox preview proxies through a generated *.e2b.app hostname
    allowedHosts: [".e2b.app", "localhost"],
  },
});
