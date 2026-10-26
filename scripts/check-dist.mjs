/* Guards the one failure mode that looks like "the site is just white":
 * index.html loading, but the JS or CSS it points at not existing.
 *
 * Runs after `vite build`, fails the build instead of the deploy. */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");
const html = await readFile(join(dist, "index.html"), "utf8");

const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
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

if (problems.length) {
  console.error("dist check failed:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log(
  `dist check ok — ${local.length} local refs resolve, entry ${entry}, css ${css ?? "missing"}`
);
