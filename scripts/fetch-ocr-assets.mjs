/**
 * Put the text-recognition engine into `public/ocr/`.
 *
 * Text recognition runs *in the browser*, which means the engine has to be
 * served from our own origin — no CDN, no request leaving the page, and it still
 * works after the phone has gone offline. Three files are needed:
 *
 *   ocr/worker.min.js                    the recogniser, running in a worker
 *   ocr/core/tesseract-core-lstm.wasm.js the engine, WASM embedded as base64
 *   ocr/lang/eng.traineddata.gz          the English language model (int8)
 *
 * The engine file is self-contained — `tesseract-core-lstm.wasm.js` carries its
 * 2.8 MB of WASM inline, so there is no second .wasm request to get wrong (and
 * one fewer file to cache).
 *
 * They are taken from the exact npm packages the code depends on, so what ships
 * is what was tested. They are *not* committed: ~10 MB of binaries in git would
 * be re-downloaded by every clone for a feature most pages never need. This
 * script fetches them once per checkout (and CI runs it as part of the build).
 *
 *   npm run ocr:assets
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "public", "ocr");
const STAMP = join(OUT, ".version");

/** Pinned on purpose: the model and the code that reads it have to match. */
const PACKAGES = {
  "tesseract.js": "7.0.0",
  "tesseract.js-core": "7.0.0",
  "@tesseract.js-data/eng": "1.0.0",
};

const FILES = [
  {
    pkg: "tesseract.js",
    from: "package/dist/worker.min.js",
    to: "worker.min.js",
    why: "the recogniser itself",
  },
  {
    pkg: "tesseract.js-core",
    from: "package/tesseract-core-lstm.wasm.js",
    to: "core/tesseract-core-lstm.wasm.js",
    why: "the engine (WASM inline)",
  },
  {
    pkg: "@tesseract.js-data/eng",
    // int8 ("best_int"): a third of the size of the float model and roughly
    // twice as fast on a phone, at a difference nobody can see in the text
    from: "package/4.0.0_best_int/eng.traineddata.gz",
    to: "lang/eng.traineddata.gz",
    why: "the English language model",
  },
];

const version = Object.entries(PACKAGES)
  .map(([name, v]) => `${name}@${v}`)
  .join(" ");

function present() {
  if (!existsSync(STAMP)) return false;
  if (readFileSync(STAMP, "utf8").trim() !== version) return false;
  return FILES.every((file) => existsSync(join(OUT, file.to)));
}

if (present() && !process.argv.includes("--force")) {
  console.log(`ocr assets: already there (${version})`);
  process.exit(0);
}

console.log(`ocr assets: fetching ${version}`);

let tar = null;
try {
  tar = execFileSync("tar", ["--version"], { stdio: "pipe" }).toString().split("\n")[0];
} catch {
  console.error(
    "ocr assets: `tar` is required to unpack the npm tarballs (it ships with macOS, " +
      "Linux and Windows 10+). Install it, or copy public/ocr/ from another checkout."
  );
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "scano-ocr-"));
try {
  for (const file of FILES) {
    const spec = `${file.pkg}@${PACKAGES[file.pkg]}`;
    const dir = join(work, file.pkg.replace(/[^a-z0-9]/gi, "_"));
    mkdirSync(dir, { recursive: true });
    const tarball = execFileSync("npm", ["pack", spec, "--silent", "--pack-destination", dir], {
      cwd: dir,
      stdio: ["ignore", "pipe", "inherit"],
    })
      .toString()
      .trim()
      .split("\n")
      .pop();
    // one tarball per package, unpacked once
    const marker = join(dir, ".unpacked");
    if (!existsSync(marker)) {
      execFileSync("tar", ["-xzf", join(dir, tarball)], { cwd: dir, stdio: "pipe" });
      writeFileSync(marker, "");
    }
    const from = join(dir, file.from);
    if (!existsSync(from)) {
      console.error(`ocr assets: ${file.from} is not in ${spec} — package layout changed`);
      process.exit(1);
    }
    const to = join(OUT, file.to);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`  ${file.to}  (${file.why})`);
  }
  writeFileSync(STAMP, `${version}\n${tar}\n`);
  console.log(`ocr assets: ready in public/ocr`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
