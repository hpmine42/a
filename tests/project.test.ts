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

describe("service worker", () => {
  const sw = read("public/sw.js");

  it("precaches the shell, so a cold launch is never an error page", () => {
    expect(sw).toMatch(/const SHELL = \[/);
    expect(sw).toMatch(/cache\.add\(abs\(path\)\)/);
  });

  it("has an offline page instead of returning a network error", () => {
    expect(sw).toMatch(/OFFLINE_PAGE/);
    expect(sw).toMatch(/new Response\(OFFLINE_PAGE/);
    expect(sw).not.toMatch(/Response\.error\(\)/);
  });
});
