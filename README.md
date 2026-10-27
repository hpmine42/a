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
camera frame — desk, shadow, skew. After is what the export produces with
*Optimize* switched on.

## What it does

- **Optional live detection.** The *Detect* toggle is off by default; switched on,
  a worker finds the sheet ~2-3×/second and the outline eases into place.
- **The shutter is never a surprise.** If the viewfinder is already framing a
  sheet, that crop is used without asking. If it is not, Scano asks: crop by
  hand, detect this photo, or keep the whole frame — *Keep the whole photo* goes
  straight to the finished page, because the crop tool is exactly what it was
  just told not to use. Cropping stays one tap away in the page header.
- **Manual framing that actually lands.** Drag any corner with a magnifier loupe
  (it shows exactly the pixel under your finger), or drag the whole sheet. The
  crop tool has exactly one button — *Done cropping* — and the page is rendered
  once on the way out, so dragging stays butter-smooth instead of warping a
  photo on every finger lift. A page that was turned is drawn turned here too:
  the corners you place are the corners you get (`src/lib/orient.ts`, where the
  two frames of reference are translated and tested).
- **"Keep the whole photo" is literal.** No hairline inset either. The page is
  the frame the camera saw, edge to edge, which matters the moment text runs to
  the paper's edge.
- **Find the page, and *see* it.** Pressing *Find the page* runs one amber band
  from the top of the photo to the bottom — a single pass, never a loop that
  stops wherever the detector happened to finish — then frames what it found and
  **stops**. Nothing is created until you choose: *Use this crop* or *Crop it
  myself*. A search that finds nothing says so and leaves the same three choices
  on the sheet instead of opening a tool nobody asked for.
- **One switch, no look-hunting.** *Optimize* is off by default, because the
  photo as taken is the honest starting point; switched on it flattens the
  lighting, whitens the paper and sharpens the text. It then appears in the dock
  of the finished page, not in the crop tool, where you are not looking at the
  picture yet.
- **The preview cannot freeze.** Phones kill camera tracks when they feel like
  it and leave a convincing last frame behind. The viewfinder measures whether
  frames are actually arriving, restarts the stream when the app comes back,
  and offers *Preview paused — tap to restart* if even that fails.
- **Your pages survive a reload.** They are kept in IndexedDB as JPEG blobs plus
  the crop, the look and the rotation — the pixels come back when you open a
  page, so a twenty-page session costs one database read at launch, not a twenty
  second wait. Nothing is uploaded, and *Clear* wipes it.
- **Ten photos at once, one at a time.** A batch from the library is opened
  lazily — one decoded photo in memory, the rest still files — and the sheet says
  how many are waiting. A file the browser cannot decode (an iPhone HEIC in
  Chrome, say) is named in the open instead of being skipped in silence.
- **Multi-page PDF** at up to 3000px per page — A4, US Letter, or a page that
  matches the scan exactly — with the file name typed in the app before saving.
  On a phone *Share* hands the PDF straight to the share sheet; the download is
  the fallback, not the plan.
- **Turn, reorder, fix.** A quarter turn lives in the header next to *Crop*, and
  the header gives way before a chip does: the counter shrinks first, so *Crop*
  is never half off the screen — which it was, from twelve pages on. Pages drag
  into another slot by their grip the way Google Keep moves a note: the card
  lifts into a preview under the finger, the grid reflows *while* you drag, and a
  dashed gap shows where it will land (the arrow keys move it too, and say where
  it went). The list auto-scrolls at the edges, and removing a page is undoable
  for six seconds. The drag listens on `window`, not on the card: moving a DOM
  node releases its pointer capture, so a handler on the grip died the moment the
  grid rearranged under it — which is exactly what "it hangs and cannot be
  dragged any more" was. Letting go is a small flight, not a cut: the preview
  travels the last stretch into its slot (220 ms), the ring and the lift fade out
  on the way, and the real card takes over at the moment it arrives.
- **Tap to focus.** A tap always answers — ring where the finger was, plus a
  haptic — and asks the lens to focus there; where a browser cannot honour the
  point it falls back to a plain refocus, and if the lens cannot be asked at all
  it says so once instead of flashing a ring that means nothing. Plus an opt-in
  *Auto* shutter that fires
  once the outline has held still for most of a second — for when the phone is
  propped up and both hands are busy with the book.
- **Two pages in one photo** (an open book, two receipts): the detector looks
  for a second, non-overlapping sheet and, when it finds one, the review sheet
  shows both outlines and asks *Scan both pages* or *Just the first one*.
- **Pinch to zoom in the viewfinder**, with 0.5× / 1× / 2× chips and a switch to
  the ultra-wide lens when the phone exposes one. Everywhere else the app holds
  pinch-to-zoom shut, because it only ever fights the user.
- **Light on first load.** The app shell is 53 kB gzipped; jsPDF and its
  dependencies (~370 kB) are fetched in the background while the camera is up —
  not at the moment of export, because a lazy chunk that was never fetched is
  exactly what makes "save" fail on a phone that has gone offline since.
  Data Saver and 2G links skip that warm-up.
- **Installable** — a real PWA with an offline shell. Add it to the home screen
  and it keeps working with no network at all. The service worker's cache name
  is stamped with the build (`vite.config.ts`), so a deploy throws the old shell
  away instead of serving it forever, and its runtime cache is capped at 60
  entries so hashed bundles cannot accumulate.

## Mobile first

One thumb, one hand: full-bleed viewfinder, 52px chips, a 96px shutter (the same
diameter as Google's camera), safe-area aware docks, `100dvh` layout and no
horizontal overflow. Every size is a token multiplied by `--u`, so the whole UI
can scale as one piece. The desktop-only "phone on a desk" frame is gated behind
`(hover: hover) and (pointer: fine)` so a real phone always gets the whole
screen.

Sizes are deliberately matched to Google's scanner: 96px shutter, 52px labelled
chips, 54px round buttons, 12.5px captions. On a 390px phone the camera's top
bar has to hold a wordmark and three labelled chips (Detect, Auto, Light), so
those chips drop to 46px there — still a comfortable target — and the row wraps
rather than letting the last chip run off the edge, which is what a fixed row
did before.

Some phones browse in "desktop site" mode, which reports a ~980px viewport on a
~410px screen and makes the browser paint everything at about 40%. `src/lib/fit.ts`
measures that mismatch and sets `--u`, so the UI comes out the right size anyway.
`?u=2.4` forces a scale by hand if a browser is being creative.

Two things about that measurement are worth knowing, because both were a bug on a
real phone:

- **A launch is not a measurement.** A PWA cold start can report the desktop
  layout width for the first frames, before the viewport meta is honoured. One
  sample taken then was a 2.4× UI for the rest of the session — "sometimes it
  opens bigger and you have to scroll" — because nothing fires a `resize` to
  correct it. The decision now needs corroboration (the visual viewport says the
  page really is painted small, or the visible width agrees with the layout
  width), and the reading is repeated after the app is up and whenever it comes
  back to the foreground, so a wrong boost takes itself back.
- **`100dvh` is not the visible height in a standalone app.** With the status bar
  over the page and the gesture bar below it, the layout can be a few dozen
  pixels taller than the screen: the document scrolls by that sliver and the top
  bar arrives with its chips cut off. The shell is sized from
  `visualViewport.height` (`--app-h`), capped at the viewport, and the document
  itself never scrolls — the lists inside do.

## How the pictures get good

A phone photo of a page is paper multiplied by the light falling on it, and that
light is never even. So `enhance()` works in this order:

1. **Flatten the illumination** — estimate the light as a heavy blur of the
   luma, then divide it out. Shadows stop being something the threshold has to
   fight, which is what used to leave grey blotches and grey paper.
2. **Stretch the levels** on the 2%–98.5% percentiles of the *lit* page,
   ignoring the tails.
3. **Smooth** with a 3×3 box in Optimize mode — a threshold cannot tell sensor
   grain from a full stop, so the grain goes first. (Colour mode sharpens with
   an unsharp mask instead; there the pixels are the product.)
4. **Threshold** (B&W) with a Sauvola map computed on a small copy and sampled
   back up — soft edges, so small type stays readable instead of turning into
   speckle.

Imports are read at up to 3600px, exports at 3000px, and neither is ever scaled
above what the photo actually contains. Anything that would exceed 8 megapixels
or 4096px on a side is rendered a little smaller on purpose: past those numbers
iOS Safari hands back a blank canvas instead of an error, and a blank page in a
PDF is worse than a page that is 20% smaller.

The editor renders its preview at about 1.35× the pixel size of the canvas it
draws into, and never beyond ~1.6× the page's own resolution. That ratio is the
whole difference between *crisp* and *blurry* for thresholded text: black and
white glyph edges survive a downscale badly, so the canvas wants more source
pixels than it has output pixels. (Sizing the preview by the stage's height
instead — which is what it used to do — rendered a page taller than the canvas
and squeezed it, and that is what made Optimize look softer than the photo.)

An export plans for failure, because a phone is a hostile place to build a 3000px
document. Each page is rendered, checked, and re-rendered smaller if the browser
handed back an empty canvas — the silent way a canvas past its memory limit
fails, and how a PDF full of blank pages used to happen. A page that cannot be
rendered at any size stops the export with a sentence that names the problem
instead of a shrug. Twenty pages share a smaller pixel budget than one, because
being killed halfway through a long export is the one failure there is no
recovery from. And the PDF itself is built when the grid goes idle: a phone only
lets you share a file for a few seconds after a tap, and a multi-page build takes
longer than that — with the file ready, Share opens instantly.

The crop is pulled in by 0.8%, because detection and hand-placed corners both
tend to sit a little outside the paper — that sliver of desk is the dark line
along the edge of an otherwise clean scan.

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

The winner is then snapped precisely, checked against a second opinion from the
*unclosed* mask (closing glues a pen or a shadow to the sheet and inflates the
rectangle, the raw blob does not), warped with a homography and thresholded
with Sauvola. Colour is used throughout: a pale
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
src/lib/orient.ts the photo frame ↔ the page frame, for turned pages
src/lib/storage.ts IndexedDB (with an in-memory twin the tests drive)
src/lib/share.ts  the share sheet, and the download it falls back to
src/lib/fit.ts    the UI scale that undoes a browser's desktop-mode shrink
scripts/          test-cv.ts (real pipeline), check-dist.mjs (deploy guard)
```

Nothing in `src/lib` touches the network. The service worker only caches the
app's own files, which is why "works offline" is a property and not a promise.
The only thing that leaves the device is a PDF the user explicitly shares.

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
that wrong prints cropped documents, `tests/geometry.test.ts` pins the
canvas → image mapping that the magnifier depends on, and
`tests/orient.test.ts` proves that cropping a turned page gives the same picture
as turning the photo and cropping there.

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

The four corners are also four real buttons sitting invisibly on top of the
drawn handles: Tab reaches them, the arrow keys move the focused corner by a
pixel (ten with Shift / Cmd), and the canvas draws the ring so you can see what
has focus. The page grips in the grid take arrow keys the same way.

## Roadmap

- OCR layer (tesseract.js) so exported PDFs are searchable
- Share-target on mobile (receive photos from other apps)
- Optional signature and redaction tools
- Per-page paper size, for the mixed-size scan

## License

MIT
