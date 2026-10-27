/**
 * Run the real text engine on the demo page.
 *
 * The unit tests mock the recogniser (it cannot run in jsdom), and `check-dist`
 * only proves the files are *there*. This is the one check that proves they
 * *work*: it loads the English model from `public/ocr/lang`, reads the demo
 * invoice the pipeline produced, and fails if the words a scanner must not miss
 * are missing.
 *
 *   npm run test:ocr
 *
 * Node's tesseract.js takes the engine from the package itself, so what this
 * verifies is the language data and the pipeline around it; the WASM build in
 * `public/ocr/core/` is checked for shape by `scripts/check-dist.mjs`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWorker } from "tesseract.js";

const ROOT = resolve(import.meta.dirname, "..");
const LANG = resolve(ROOT, "public/ocr/lang");
const IMAGE = resolve(ROOT, "docs/after.jpg");

if (!existsSync(LANG) || !existsSync(IMAGE)) {
  console.error("ocr test: run `npm run ocr:assets` and `npm run docs:images` first");
  process.exit(1);
}

const EXPECTED = ["ACME", "INVOICE", "1,620.00", "Hosting", "14 Days"];

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const started = Date.now();
const worker = await createWorker("eng", 1, {
  langPath: LANG,
  gzip: true,
  cacheMethod: "none",
  logger: () => {},
});

const { data } = await worker.recognize(readFileSync(IMAGE), {}, { text: true, blocks: true });
await worker.terminate();
const elapsed = Date.now() - started;

const text = data.text;
const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));

console.log(`\nScano · text recognition\n  ${words.length} words, mean confidence ${Math.round(data.confidence)}\n`);
for (const word of EXPECTED) {
  check(`reads "${word}"`, text.includes(word), text.includes(word) ? "" : "missing from the output");
}
check("finds word boxes", words.length > 60, `${words.length} boxes`);
check(
  "boxes sit inside the page",
  words.every((w) => w.bbox.x1 > w.bbox.x0 && w.bbox.y1 > w.bbox.y0),
  ""
);
check("is quick enough on a page", elapsed < 12_000, `${elapsed}ms including engine start`);

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
