<p align="center">
  <img src="docs/banner.svg" alt="flatbed — the scanner that lives in your browser" width="100%">
</p>

<p align="center">
  <b>Photograph a document. Get a straight, clean, multi-page PDF.</b><br>
  No upload · no account · no install · Vue 3 + TypeScript, runs in the tab.
</p>

<p align="center">
  <a href="../../actions/workflows/ci.yml"><img alt="CI" src="../../actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42b883">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
</p>

---

You need one page as a PDF. So you take a phone photo — crooked, grey, a shadow
across the bottom, half the desk in frame — and every scanner app wants an
account and an upload.

flatbed does the boring part properly, in the browser, and the photo never
leaves the device.

## Before / after

| Camera photo | flatbed |
|---|---|
| ![](docs/before.jpg) | ![](docs/after.jpg) |

Both images come from the demo photo that ships with the app.

## What it does

- **Live detection in the viewfinder.** A worker finds the sheet ~3×/second and
  the outline eases into place. Nothing to tap if it already looks right.
- **Automatic crop on capture.** The detected quad is warped straight into a
  rectangle the moment you press the shutter.
- **Manual framing when it matters.** Tap the crop button: drag any corner with
  a magnifier loupe for pixel-level placement, or drag the whole sheet. Every
  release re-renders the page.
- **Three looks** — clean B&W (adaptive threshold, shadow-proof), grayscale,
  colour — as one-tap swatches.
- **Multi-page PDF** at up to 2600px per page — A4, US Letter, or a page that
  matches the scan exactly.
- **Installable** — a real PWA with an offline shell. Add it to the home screen
  and it keeps working with no network at all.

## How the detection works

No ML model and no WASM download — about 800 lines of TypeScript in
[`src/lib/cv.ts`](src/lib/cv.ts):

1. **Paperness mask** — bright, low chroma, and red not far above blue. That
   last term is what keeps a warm wooden desk out of the mask.
2. **Morphological closing** — printed text punches holes into a sheet; without
   closing, a page is never one connected blob.
3. **Component scoring** — each blob is scored by how completely its
   minimum-area rectangle is filled. A page scores ~0.9, a bright desk patch
   does not.
4. **Edge snapping** — every side is slid *and* tilted while measuring edge
   strength plus polarity (paper brighter than the desk). Lines keep the coarse
   orientation, so corners stay sane when an edge is partly occluded.
5. **Homography warp**, then a Sauvola threshold for the output.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

If the browser blocks camera access (or you are on desktop), the app offers
**Demo photo** so the whole flow is still one tap away.

## Tests

```bash
npm run typecheck  # vue-tsc, strict
npm run test:cv    # real CV pipeline on the demo photo, with assertions
npm test           # UI flows in jsdom + PDF page geometry
```

`test:cv` is the honest one: it detects the page in `public/samples/letter.jpg`,
checks the corners against hand-measured coordinates, and fails the build if the
detector drifts. `tests/pdf.test.ts` covers the placement maths, because getting
that wrong prints cropped documents.

The B&W output runs a despeckle pass after the adaptive threshold: paper grain
and JPEG noise become visible dirt once a page is pure black and white, and
isolated pixels are not glyphs.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck, both
test suites and the build on every push and PR, then deploys `main` to GitHub
Pages.

## Roadmap

- OCR layer (tesseract.js) so exported PDFs are searchable
- Drag to reorder pages in the filmstrip
- Batch split: several receipts in one photo
- Share-target on mobile (receive photos from other apps)

## License

MIT
