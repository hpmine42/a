<p align="center">
  <img src="docs/banner.svg" alt="Scano — the scanner that lives in your browser" width="100%">
</p>

<p align="center">
  <b>Photograph a document. Get a straight, clean, multi-page PDF.</b><br>
  No upload · no account · no install · Vue 3 + TypeScript, runs in the tab.
</p>

<p align="center">
  <a href="../../actions/workflows/ci.yml"><img alt="CI" src="../../actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42b883">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-ffc061">
  <img alt="Works offline" src="https://img.shields.io/badge/works-offline-ffc061">
</p>

---

**Live: <https://hpmine42.github.io/scano/>** — no install, no account.

You need one page as a PDF. So you take a phone photo — crooked, grey, a shadow
across the bottom, half the desk in frame — and every scanner app wants an
account and an upload.

Scano does the boring part properly, in the browser, and the photo never
leaves the device.

## Why it exists

Every scanner app wants an account, an upload, or a subscription — for a task
that is a perspective transform and a threshold. Scano is that transform and
that threshold, in ~1,200 lines of TypeScript, with the photo never leaving the
phone. MIT, no backend, no analytics, no CDN.

## Before / after

| Camera photo | Scano |
|---|---|
| ![](docs/before.jpg) | ![](docs/after.jpg) |

Both images come from the demo photo that ships with the app. Before is the raw
camera frame — desk, shadow, skew. After is what the export produces.

## What it does

- **Optional live detection.** The *Detect* toggle is off by default; switched on,
  a worker finds the sheet ~2-3×/second and the outline eases into place.
- **The shutter is never a surprise.** If the viewfinder is already framing a
  sheet, that crop is used without asking. If it is not, Scano asks: crop by
  hand, detect this photo, or keep the whole frame.
- **Manual framing that actually lands.** Drag any corner with a magnifier loupe
  (it shows exactly the pixel under your finger), or drag the whole sheet. The
  page is re-rendered once, when you leave the crop tool, so dragging stays
  butter-smooth instead of warping a photo on every finger lift.
- **One switch, no look-hunting.** *Optimize* flattens the lighting, whitens the
  paper and sharpens the text; off gives you the straight photo exactly as it
  was taken. It is the only image control in the app, and it costs one pass
  over the preview rather than a re-import.
- **Multi-page PDF** at up to 3000px per page — A4, US Letter, or a page that
  matches the scan exactly — with the file name typed in the app before saving.
- **Pinch to zoom in the viewfinder**, with 0.5× / 1× / 2× chips and a switch to
  the ultra-wide lens when the phone exposes one. Everywhere else the app holds
  pinch-to-zoom shut, because it only ever fights the user.
- **Light on first load.** jsPDF and its dependencies (~370 kB) are only
  downloaded when a PDF is actually saved; the app itself is 53 kB gzipped.
- **Installable** — a real PWA with an offline shell. Add it to the home screen
  and it keeps working with no network at all.

## Mobile first

One thumb, one hand: full-bleed viewfinder, 52px chips, a 96px shutter (the same
diameter as Google's camera), safe-area aware docks, `100dvh` layout and no
horizontal overflow. Every size is a token multiplied by `--u`, so the whole UI
can scale as one piece. The desktop-only "phone on a desk" frame is gated behind
`(hover: hover) and (pointer: fine)` so a real phone always gets the whole
screen.

Sizes are deliberately matched to Google's scanner: 96px shutter, 52px labelled
chips, 54px round buttons, 12.5px captions.

Some phones browse in "desktop site" mode, which reports a ~980px viewport on a
~410px screen and makes the browser paint everything at about 40%. `src/lib/fit.ts`
measures that mismatch and sets `--u`, so the UI comes out the right size anyway.
`?u=2.4` forces a scale by hand if a browser is being creative.

## How the pictures get good

A phone photo of a page is paper multiplied by the light falling on it, and that
light is never even. So `enhance()` works in this order:

1. **Flatten the illumination** — estimate the light as a heavy blur of the
   luma, then divide it out. Shadows stop being something the threshold has to
   fight, which is what used to leave grey blotches and grey paper.
2. **Stretch the levels** on 2%–98.5% percentiles, ignoring the tails.
3. **Sharpen** with an unsharp mask sized for grain, not for edges.
4. **Threshold** (B&W) with a Sauvola map computed on a small copy and sampled
   back up — soft edges, so small type stays readable instead of turning into
   speckle.

Imports are read at up to 3600px and exports at 3000px. The editor renders at
the size of the glass instead of a fixed 2400px — a page shown 390px wide gains
nothing from a 6× oversampled buffer, and the difference is what makes toggling
*Optimize* feel instant. The crop is pulled in by 0.8%, because detection and
hand-placed corners both tend to sit a little outside the paper — that sliver of
desk is the dark line along the edge of an otherwise clean scan.

## How the detection works

No ML model and no WASM download — plain TypeScript in
[`src/lib/cv.ts`](src/lib/cv.ts). Three candidate sources feed one ranked list:

1. **Paperness masks at several thresholds** — bright, low chroma, red not far
   above blue. The warmth term keeps a wooden desk out; high percentiles of the
   luma histogram find a white sheet on a pale desk where Otsu fails. Printed
   text is closed away morphologically.
2. **Blob scoring** — each blob's minimum-area rectangle is scored on *fill*
   (does the rectangle actually match the blob?), *contrast* (is the inside
   brighter **or** less colourful than the outside?), *edge sharpness* and size.
3. **Edge snap from the frame** — for paper a colour mask cannot separate
   (white on white), four seed frames let each side slide onto the strongest
   paper-over-desk edge. Gates on movement, gradient and paper evidence keep an
   empty desk from being reported as a document.

The winner is then snapped precisely, and the result is warped with a
homography and thresholded with Sauvola. Colour is used throughout: a pale
wooden desk can match paper in brightness while being obviously different in
hue, which is exactly where a luma-only detector fails.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

If the browser blocks camera access (or you are on desktop), the app offers
**Demo photo** so the whole flow is still one tap away.

## Structure

```
src/components/   CameraView, CaptureReview, EditorView, CornerEditor, PagesView
src/lib/cv.ts     detection, homography warp, enhancement — no dependencies
src/lib/pdf.ts    jsPDF layout; fitOnPage is pure and unit-tested
src/lib/store.ts  pages, options, the preview/export resolution budgets
src/lib/fit.ts    the UI scale that undoes a browser's desktop-mode shrink
scripts/          test-cv.ts (real pipeline), check-dist.mjs (deploy guard)
```

Nothing in `src/lib` touches the network. The service worker only caches the
app's own files, which is why "works offline" is a property and not a promise.

## Tests

```bash
npm run typecheck  # vue-tsc, strict
npm run test:cv    # real CV pipeline on the demo photo, with assertions
npm test           # UI flows, detection on synthetic scenes, loupe maths, PDF geometry
```

`test:cv` is the honest one: it detects the page in `public/samples/letter.jpg`,
checks the corners against hand-measured coordinates, and fails the build if the
detector drifts. `tests/detect.test.ts` renders synthetic desks — dark, warm,
low-contrast, empty — and asserts both the found corners and the *refusal* to
find a page where there is none. `tests/pdf.test.ts` covers the placement maths, because getting
that wrong prints cropped documents, and `tests/geometry.test.ts` pins the
canvas → image mapping that the magnifier depends on.

The B&W output runs a despeckle pass after the adaptive threshold: paper grain
and JPEG noise become visible dirt once a page is pure black and white, and
isolated pixels are not glyphs.

## Installing it as an app

Chrome/Android: open the site, tap **Install Scano** in the viewfinder. iOS: Share
→ *Add to Home Screen*. It then runs standalone, offline included.

### "It says it is already installed, and it will not open"

This is the one install failure that has nothing to do with the code. GitHub does
not redirect a project site after a repository is renamed: an app installed while
the site lived at `/scanner/` keeps a start address that now returns 404. Android
still lists the entry — so the install sheet says *already installed* — and
launching it fails, because there is nothing at that address any more.

The page detects that situation (`getInstalledRelatedApps()` against the
`related_applications` entry in the manifest) and offers **Fix the installed
app** with the two steps below. Doing it by hand works just as well:

1. Long-press the Scano icon → **App info** → **Uninstall**.
   No icon? **Settings → Apps → Scano → Uninstall**.
2. Reload the site and tap **Install Scano** again.

Only one install exists afterwards, and it points at the current address.

## Deployment

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every push
to `main`, on every pull request, **on a daily schedule** and on demand. The
build job typechecks, runs both test suites and builds; the deploy job publishes
to GitHub Pages, then loads the live URL and checks that the served
`index.html` is the built one and that `manifest.webmanifest` and `sw.js`
resolve — a deploy that published nothing turns the run red instead of leaving a
white page.

`configure-pages` runs with `enablement: true`, so if Pages is not set up for a
fork, a renamed repository or a reset environment, the workflow creates it
itself instead of waiting for a manual click. Nothing about deployment depends
on a setting someone has to remember.

## Keyboard and desktop

The app is built for a thumb, but it is usable with a mouse: the corner editor
takes a drag with the magnifier following the pointer, `Escape` goes back to the
camera, and the desktop browser gets the same UI in a phone-sized frame (that
frame is a `(hover: hover) and (pointer: fine)` rule, never a mobile layout).

## Roadmap

- OCR layer (tesseract.js) so exported PDFs are searchable
- Drag to reorder pages in the filmstrip
- Batch split: several receipts in one photo
- Share-target on mobile (receive photos from other apps)
- Optional signature and redaction tools

## License

MIT
