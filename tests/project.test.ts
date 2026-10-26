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
