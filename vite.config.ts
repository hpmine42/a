import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * Files a build never needs offline.
 *
 * `sw.js` is the worker itself (the browser keeps it), `social.png` is the
 * link-preview image that no launch ever fetches, and the wide sample is the
 * second demo photo — the one the "try a sample" button uses is kept.
 */
const NOT_PRECACHED = [/^sw\.js$/, /^social\.png$/, /^samples\/letter-scan\.jpg$/];

/** Every file in `dir`, as "./path" entries relative to the site root. */
function precacheFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...precacheFiles(resolve(dir, entry.name), rel));
      continue;
    }
    if (NOT_PRECACHED.some((pattern) => pattern.test(rel))) continue;
    out.push(`./${rel}`);
  }
  return out.sort((a, b) =>
    a === "./index.html" ? -1 : b === "./index.html" ? 1 : a.localeCompare(b)
  );
}

/**
 * Stamp the service worker, and hand it the list of files to keep.
 *
 * A cache name is the only way a service worker can promise "this deploy, not
 * the one from three weeks ago" — and a version someone has to remember to bump
 * is a version that goes stale. Both the stamp and the precache list are written
 * into the built copy only; the source keeps the placeholders.
 *
 * The list has to be *generated*. A hand-written one is the classic half-offline
 * app: the html is cached, the hashed bundle it loads is not, and the phone in
 * flight mode gets a page that never boots. Walking dist/ also means a bundle
 * renamed by the next deploy cannot be forgotten.
 */
function prepareServiceWorker(): Plugin {
  return {
    name: "scano:precache",
    apply: "build",
    closeBundle() {
      const dist = resolve(__dirname, "dist");
      const file = resolve(dist, "sw.js");
      try {
        const source = readFileSync(file, "utf8");
        if (!source.includes("__BUILD__") && !source.includes("__PRECACHE__")) return;
        const build = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
        // "./" as well as "./index.html": a launch goes to the directory, and a
        // cache lookup is by exact URL
        const list = ["./", ...precacheFiles(dist)];
        writeFileSync(
          file,
          source
            .replace(/__BUILD__/g, build)
            .replace("__PRECACHE__", JSON.stringify(list, null, 2))
        );
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
  plugins: [vue(), prepareServiceWorker()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // the sandbox preview proxies through a generated *.e2b.app hostname
    allowedHosts: [".e2b.app", "localhost"],
  },
});
