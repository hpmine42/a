import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* Guards for the things that are not in the app but decide whether the app is
 * reachable and pleasant: the deploy workflow, button text selection, and the
 * README not lying about the URL. */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("deploy workflow", () => {
  const workflow = read(".github/workflows/ci.yml");

  it("exists and runs on every push, every PR and on demand", () => {
    expect(workflow).toMatch(/^name:/m);
    expect(workflow).toMatch(/push:/);
    expect(workflow).toMatch(/branches: \[main\]/);
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
  });

  it("re-runs itself on a schedule, so a missing deploy heals without a push", () => {
    expect(workflow).toMatch(/schedule:/);
    expect(workflow).toMatch(/cron: "\d+ \d+ \* \* \*"/);
  });

  it("builds, tests and deploys", () => {
    expect(workflow).toMatch(/npm run typecheck/);
    expect(workflow).toMatch(/npm run test:cv/);
    expect(workflow).toMatch(/npm test/);
    expect(workflow).toMatch(/npm run build/);
    expect(workflow).toMatch(/actions\/deploy-pages@v4/);
  });

  it("can enable Pages itself instead of needing a manual click", () => {
    expect(workflow).toMatch(/actions\/configure-pages@v5/);
    expect(workflow).toMatch(/enablement: true/);
    expect(workflow).toMatch(/pages: write/);
    expect(workflow).toMatch(/id-token: write/);
  });

  it("verifies the live site instead of trusting a green tick", () => {
    expect(workflow).toMatch(/Verify the live site is the built app/);
    expect(workflow).toMatch(/manifest\.webmanifest/);
    expect(workflow).toMatch(/sw\.js/);
  });
});

describe("selection", () => {
  const css = read("src/styles.css");

  it("does not let a tap or a long press select control labels", () => {
    const button = css.slice(css.indexOf("\nbutton {"), css.indexOf("button:disabled"));
    expect(button).toMatch(/user-select: none/);
    expect(button).toMatch(/-webkit-touch-callout: none/);
  });

  it("keeps the file name field selectable", () => {
    expect(css).toMatch(/\.name-input input/);
    // nothing in the name field rules may switch selection off
    const field = css.slice(css.indexOf(".name-input input"));
    expect(field.slice(0, field.indexOf("}"))).not.toMatch(/user-select: none/);
  });
});

describe("camera top bar", () => {
  const css = read("src/styles.css");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} must exist`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  it("wraps instead of pushing the last chip off the screen", () => {
    expect(block(".camera-top")).toMatch(/flex-wrap: wrap/);
    expect(block(".camera-top-right")).toMatch(/flex-wrap: wrap/);
    // the stage clips to a 26px radius: a chip at a 14px inset looked cut off
    expect(block(".camera-top")).toMatch(/padding: max\(calc\(18px/);
  });

  it("shrinks the chips on a narrow phone, but not below a real target", () => {
    const media = css.slice(css.indexOf("@media (max-width: 479px)"));
    expect(media.slice(0, 900)).toMatch(/\.camera-top \.control \{[^}]*height: calc\(46px/);
  });
});

describe("the editor top bar", () => {
  const css = read("src/styles.css");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} must exist`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  it("never clips a control, however long the page number gets", () => {
    // The counter grows with the count ("1/1" is three characters, "12/12" is
    // five), and with the old spacing those 20px pushed the last chip past the
    // right edge — "Crop" was cut in half on a 412px phone. The chips keep
    // their labels now, and the counter is the one thing that gives way.
    // nothing may be pushed off the edge: the counter is the one thing that
    // gives way first, and as a last resort a chip narrows instead of leaving
    // the screen (a clipped control is unusable, a narrow one is not)
    expect(block(".editor-count")).toMatch(/flex: 0 1 auto/);
    expect(block(".editor-count")).toMatch(/min-width: 0/);
    expect(block(".editor-count")).toMatch(/text-overflow: ellipsis/);
    expect(block(".editor-top .control")).toMatch(/flex: 0 1 auto/);
    expect(block(".editor-top .control")).toMatch(/min-width: 0/);
    expect(block(".editor-actions")).toMatch(/min-width: 0/);
    // and the row itself got tighter rather than wider
    expect(block(".editor-top")).toMatch(/gap: calc\(8px/);
    // (the top inset is the safe area, see "the shell fits the screen it is on")
    expect(block(".editor-top")).toMatch(/calc\(12px \* var\(--u\)\) calc\(10px \* var\(--u\)\)/);
  });
});

describe("dragging a page", () => {
  const css = read("src/styles.css");
  const view = read("src/components/PagesView.vue");

  it("previews the move while the finger is down, like Google Keep", () => {
    // the order changes during the drag, not on drop
    expect(view).toMatch(/function aim\(\)/);
    expect(view).toMatch(/reorder\(current, target\)/);
    expect(view).toMatch(/@pointerdown="onGripDown\(\$event, page\.id\)"/);
    // and the card under the finger is drawn as a floating preview
    expect(view).toMatch(/<Teleport to="body">/);
    expect(view).toMatch(/class="drag-ghost"/);
    // the grid does its own FLIP: TransitionGroup's move animation gives up
    // whenever its first child has no transform transition — which is exactly
    // the dragged card — so pulling the top page down moved nothing
    expect(view).toMatch(/function glideFrom\(/);
    expect(view).toMatch(/el\.animate\(/);
    expect(view).toMatch(/reorder\(current, target\)/);
  });

  it("listens on the page, not on the card that is about to move", () => {
    // Moving a DOM node releases pointer capture: with the handlers on the grip,
    // the drag died the moment the grid rearranged ("bleibt einfach hängen").
    expect(view).toMatch(/window\.addEventListener\("pointermove"/);
    expect(view).toMatch(/window\.addEventListener\("pointerup"/);
    expect(view).toMatch(/window\.addEventListener\("pointercancel"/);
    expect(view).not.toMatch(/setPointerCapture/);
  });

  it("draws the loupe crosshair in screen space, not through the zoom", () => {
    // The cross used to be drawn after the magnifier's scale transform, so its
    // screen coordinates were read as source pixels: it landed hundreds of
    // pixels outside the loupe and was clipped away ("kein Kreuz in der Mitte").
    const corner = read("src/components/CornerEditor.vue");
    const loupe = corner.slice(corner.indexOf("function drawLoupe("));
    const magnify = loupe.indexOf("g.drawImage(img, 0, 0);");
    const restore = loupe.indexOf("g.restore();", magnify);
    const crosshair = loupe.indexOf("reticle(centre.x, centre.y, R)");
    expect(magnify).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(magnify);
    // the crosshair comes after the transform is gone again
    expect(crosshair).toBeGreaterThan(restore);
    // and it is drawn twice: a dark halo, then amber, so white paper does not
    // swallow it
    expect(loupe).toMatch(/cross\(4\.8, "rgba\(6, 7, 9, 0\.6\)"\)/);
    expect(loupe).toMatch(/cross\(1\.9, "#ffc061"\)/);
  });

  it("does not tilt the preview and does not fade the card", () => {
    // both read as glitches under the finger, not as feedback
    const ghostStyle = view.slice(view.indexOf("class=\"drag-ghost\""), view.indexOf("drag-ghost-num"));
    expect(ghostStyle).not.toMatch(/rotate\(/);
    expect(ghostStyle).toMatch(/translate3d/);
    expect(css).not.toMatch(/\.page-card\.settled/);
    expect(css).not.toMatch(/@keyframes card-settle/);
    // no transition on the card, so nothing can fade on its way to the gap
    const card = css.slice(css.indexOf("\n.page-card {"), css.indexOf("\n.page-card {") + 120);
    expect(card).not.toMatch(/transition:.*opacity/);
  });

  it("flies the held card into its slot when you let go", () => {
    // The drop used to be a cut: one frame of a floating page, the next frame
    // nothing. The preview now travels the rest of the way and the real card
    // takes over when it arrives.
    expect(view).toMatch(/function flyHome\(/);
    expect(view).toMatch(/class="drag-ghost"\s*\n?\s*:class="\{ landing \}"/);
    expect(css).toMatch(/\.drag-ghost\.landing \{[^}]*transition:/);
    expect(css).toMatch(/\.drag-ghost\.landing \{[^}]*transform 0\.22s/);
  });

  it("leaves a gap where the page will land instead of a marker line", () => {
    expect(css).toMatch(/\.page-card\.dragging \{[^}]*opacity: 0/);
    expect(css).toMatch(/\.page-card\.dragging::after \{[^}]*dashed/);
    // no move class to rely on: it was defeated by `.page-card.dragging`
    expect(css).not.toMatch(/\.card-move/);
    expect(css).toMatch(/\.drag-ghost \{[^}]*position: fixed/);
    // the old "drop here" marker is gone with the old behaviour
    expect(css).not.toMatch(/\.drop-before/);
  });
});

describe("the shell fits the screen it is on", () => {
  const css = read("src/styles.css");
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} must exist`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  it("sizes the app from the visible area, not from 100dvh", () => {
    // a standalone PWA counts the status bar and the gesture bar, so 100dvh can
    // be taller than the screen: the app then scrolls by that sliver and the top
    // bar is cut off ("sometimes it opens bigger and you have to scroll")
    expect(block(".app")).toMatch(/height: var\(--app-h, 100dvh\)/);
    expect(block(".app")).toMatch(/max-height: 100%/);
  });

  it("does not let the document scroll at all", () => {
    const start = css.indexOf("html,\nbody {");
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toMatch(/overflow: hidden/);
    expect(rule).toMatch(/overscroll-behavior: none/);
  });

  it("keeps the desktop frame centred instead of letting it grow", () => {
    expect(css).toMatch(/max-height: 94dvh/);
  });
});

describe("the crop view stays still", () => {
  const css = read("src/styles.css");

  it("only shakes when a search actually failed", () => {
    // This rule once read `.corner-canvas { animation: corner-miss ... }`, so
    // the picture wobbled every single time the crop tool opened.
    const canvas = css.slice(css.indexOf("\n.corner-canvas {"));
    const rule = canvas.slice(0, canvas.indexOf("}"));
    expect(rule).not.toMatch(/animation/);
    expect(css).toMatch(/\.corner-editor\.missed \.corner-canvas \{[^}]*corner-miss/);
  });

  it("fades the crop view in instead of snapping to a different size", () => {
    const block = css.slice(css.indexOf("\n.corner-editor {"));
    expect(block.slice(0, block.indexOf("}"))).toMatch(/animation: corner-in/);
  });
});

describe("readme", () => {
  const readme = read("README.md");

  it("points at the live site", () => {
    expect(readme).toMatch(/hpmine42\.github\.io\/scano\//);
  });

  it("no longer announces a rename that already happened", () => {
    expect(readme.toLowerCase()).not.toContain("renaming notice");
    expect(readme).not.toContain("being renamed");
  });
});

describe("web app manifest", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest"));

  it("declares an identity, so a reinstall cannot become a second app", () => {
    expect(manifest.id).toBe("./");
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
  });

  it("is installable: standalone display, both icon sizes, a maskable one", () => {
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(
      manifest.icons.some((i: { purpose?: string }) => i.purpose?.includes("maskable"))
    ).toBe(true);
  });

  it("declares itself as a related app so a stale install can be detected", () => {
    expect(manifest.prefer_related_applications).toBe(false);
    const related = manifest.related_applications ?? [];
    expect(related.length).toBeGreaterThan(0);
    expect(related[0].platform).toBe("webapp");
    expect(related[0].url).toMatch(/manifest\.webmanifest$/);
  });
});

describe("text recognition", () => {
  const store = read("src/lib/store.ts");
  const ocr = read("src/lib/ocr.ts");
  const fetchAssets = read("scripts/fetch-ocr-assets.mjs");
  const config = read("vite.config.ts");

  it("reads the finished page at a size where letters still exist", () => {
    // 900 (the preview) merges letters; the export size only costs time
    expect(store).toMatch(/export const OCR_SIDE = 1800;/);
    // a copy at that size, not the page itself: rendering the preview at the
    // engine's resolution replaced the sheet on screen with a smaller one
    expect(store).toMatch(/const result = renderCopy\(page, OCR_SIDE\);/);
    expect(store).not.toMatch(/processPage\(page, \{ full: true, maxSide: OCR_SIDE \}\)/);
  });

  it("runs from our own origin, in a worker, with no CDN in the path", () => {
    expect(ocr).toMatch(/workerPath: asset\("worker\.min\.js"\)/);
    expect(ocr).toMatch(/corePath: asset\("core\/tesseract-core-lstm\.wasm\.js"\)/);
    expect(ocr).toMatch(/langPath: asset\("lang"\)/);
    // a scanner that quietly fetches its engine from jsDelivr is not a scanner
    // that keeps the page on the device
    // and the worker is loaded from our own URL, so the service worker can
    // cache it: a blob worker escapes the fetch handler entirely
    expect(ocr).toMatch(/workerBlobURL: false/);
    expect(ocr).not.toMatch(/cdn\.jsdelivr/);
    expect(ocr).not.toMatch(/https?:\/\//);
  });

  it("is fetched by the build, and never precached", () => {
    // 10 MB of WASM is not something every visitor should download on launch
    expect(fetchAssets).toMatch(/4\.0\.0_best_int/);
    expect(fetchAssets).toMatch(/tesseract-core-lstm\.wasm/);
    expect(config).toMatch(/\/\^ocr\\\//);
    expect(read(".gitignore")).toMatch(/public\/ocr\//);
  });

  it("writes the words into the PDF as invisible text", () => {
    const pdf = read("src/lib/pdf.ts");
    expect(pdf).toMatch(/renderingMode: "invisible"/);
    expect(pdf).toMatch(/export function textLayerRuns/);
    expect(pdf).toMatch(/if \(page\.ocr && hasTextLayer\(page\)\)/);
  });
});

describe("service worker", () => {
  const sw = read("public/sw.js");
  const config = read("vite.config.ts");
  const main = read("src/main.ts");

  it("precaches the whole build, and the build writes the list", () => {
    // A hand-written list is the classic half-offline app: `./` is cached, the
    // hashed bundle it loads is not, and a phone in flight mode gets a page that
    // never boots. The list is generated from dist/ instead.
    expect(sw).toMatch(/const PRECACHE = __PRECACHE__;/);
    expect(sw).not.toMatch(/const SHELL = \[/);
    expect(sw).toMatch(/PRECACHE\.map\(\(path\) => cache\.add\(abs\(path\)\)\)/);
    expect(config).toMatch(/function precacheFiles\(/);
    expect(config).toMatch(/\.replace\("__PRECACHE__"/);
    expect(config).toMatch(/readdirSync/); // walking dist/, not a literal list
  });

  it("opens the cached app when the phone has no connection at all", () => {
    // navigator.onLine === false means "do not wait for a network that is not
    // there": a launch that sits on a timeout feels broken long before it fails
    expect(sw).toMatch(/self\.navigator\.onLine === false/);
    expect(sw).toMatch(/async function shell\(request\)/);
    expect(sw).toMatch(/cache\.match\(abs\("\.\/"\),?\)?/);
  });

  it("does not hang a launch on a network that never answers", () => {
    expect(sw).toMatch(/fetchWithTimeout\(request, NAV_TIMEOUT\)/);
    expect(sw).toMatch(/new AbortController\(\)/);
  });

  it("has an offline page instead of returning a network error", () => {
    expect(sw).toMatch(/OFFLINE_PAGE/);
    expect(sw).toMatch(/offlinePage\(\)/);
    expect(sw).not.toMatch(/Response\.error\(\)/);
  });

  it("checks for a new worker past the HTTP cache", () => {
    // GitHub Pages caches sw.js for ten minutes; a stale worker against a new
    // index.html is the one combination that produces a blank app
    expect(main).toMatch(/register\(`\$\{import\.meta\.env\.BASE_URL\}sw\.js`, \{ updateViaCache: "none" \}\)/);
  });
});
