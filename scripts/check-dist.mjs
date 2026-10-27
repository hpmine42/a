/* Guards the one failure mode that looks like "the site is just white":
 * index.html loading, but the JS or CSS it points at not existing.
 *
 * Runs after `vite build`, fails the build instead of the deploy. */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");
const html = await readFile(join(dist, "index.html"), "utf8");

// src/href plus meta content (og:image and friends are content="")
const refs = [...html.matchAll(/(?:src|href|content)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((v) => v.startsWith("./") || v.startsWith("/") || /^[\w-]+\.(?:png|svg|jpe?g|webp)$/.test(v));
const local = refs.filter(
  (u) => !/^(?:[a-z]+:|\/\/|#|data:)/i.test(u)
);

const problems = [];

for (const url of local) {
  const clean = url.split("?")[0].split("#")[0];
  if (!clean) continue;
  if (clean.startsWith("/")) {
    problems.push(
      `${url} is an absolute path — the deploy would 404 on GitHub Pages ` +
        `(project sites live under /<repo>/)`
    );
    continue;
  }
  const file = join(dist, clean);
  try {
    const info = await stat(file);
    if (!info.isFile()) problems.push(`${url} is not a file`);
  } catch {
    problems.push(`${url} is referenced by index.html but missing from dist/`);
  }
}

const entry = local.find((u) => /\.m?js$/.test(u));
if (!entry) problems.push("index.html references no JavaScript entry point");

// The stylesheet is what turns a broken load into a black page instead of a
// white one; assert it is actually there and has content.
const css = local.find((u) => u.endsWith(".css"));
if (css) {
  const info = await stat(join(dist, css.split("?")[0])).catch(() => null);
  if (!info || info.size < 1000) problems.push(`${css} looks empty`);
}

/**
 * The service worker is what makes the app open offline, so the build has to
 * hand it a complete list. A hand-written list is the classic half-offline app:
 * the html is cached, the hashed bundle it loads is not, and a phone in flight
 * mode gets a page that never boots.
 */
const sw = await readFile(join(dist, "sw.js"), "utf8").catch(() => "");
if (!sw) {
  problems.push("dist/sw.js is missing — the app would never work offline");
} else {
  if (/__BUILD__|__PRECACHE__/.test(sw)) {
    problems.push("dist/sw.js still has build placeholders — it was not stamped");
  }
  const match = /const PRECACHE = (\[[\s\S]*?\]);/.exec(sw);
  const list = match ? JSON.parse(match[1]) : [];
  const wanted = ["./index.html", entry?.replace(/^\.\//, "./"), css?.split("?")[0]]
    .filter(Boolean)
    .map((p) => (p.startsWith("./") ? p : `./${p}`));
  for (const file of wanted) {
    if (!list.includes(file)) problems.push(`${file} is not precached — offline launch would fail`);
  }
  const worker = list.find((p) => /detect\.worker-.*\.js$/.test(p));
  if (!worker) problems.push("the capture worker chunk is not precached");
  for (const wantedAsset of ["manifest.webmanifest", "icon-192.png"]) {
    if (!list.includes(`./${wantedAsset}`)) problems.push(`${wantedAsset} is not precached`);
  }
  // every precached file has to exist: a 404 in the list is a wasted install
  for (const item of list) {
    // "./" is the directory itself: the browser answers it with index.html
    if (item === "./") continue;
    const info = await stat(join(dist, item.replace(/^\.\//, ""))).catch(() => null);
    if (!info?.isFile()) problems.push(`${item} is precached but not in dist/`);
  }
}

if (problems.length) {
  console.error("dist check failed:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log(
  `dist check ok — ${local.length} local refs resolve, entry ${entry}, css ${css ?? "missing"}`
);
