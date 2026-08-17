import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./testing/files.test-support.js";

/**
 * `.github/workflows/release.yml` is the only place in this repository that
 * can put a listing on ClawHub. Three properties of it would fail silently
 * and expensively if a future edit undid them, and none of the three would be
 * caught by anything else in the suite (nothing here runs the workflow
 * itself; GitHub Actions is not something `npm test` can execute), so they are
 * pinned as text assertions against the committed YAML, the same technique
 * `src/docs.test.ts` already uses on `ci.yml`.
 *
 * Not pinned here, considered and rejected: that the action SHAs match
 * `ci.yml`'s (a drift there is a maintenance nuisance, not a silent one:
 * Dependabot's weekly PR would still show a divergent pin, and a security
 * scan would still catch an unpinned or stale action; it does not put a
 * wrong bundle on the registry the way the three properties below do), and
 * that `permissions: contents: read` is present (grep-shaped and easy to
 * misjudge as "passing" against a workflow that does not need the permission
 * it is missing; the reviewer reading this file is better placed to judge
 * that than a string match is).
 */

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

/**
 * The workflow's top-level `on:` block, isolated from the steps below it.
 * Scanning the whole file for `push:` would also match nothing (this
 * workflow never mentions the word), which is exactly why isolating the
 * block matters: a future step that legitimately needed to `git push` or
 * reference a `push` variable should not make this test start failing for an
 * unrelated reason.
 */
function topLevelOnBlock(yaml: string): string {
  const match = /^on:\n([\s\S]*?)(?=\n\S)/m.exec(yaml);
  if (!match) {
    throw new Error("release.yml has no top-level on: block");
  }
  return match[1]!;
}

describe("the release workflow's trigger", () => {
  it("fires on a published release and nothing else", () => {
    const on = topLevelOnBlock(workflow);
    expect(on).toMatch(/^\s*release:\s*\n\s*types:\s*\[published\]\s*$/m);
  });

  /**
   * A publish workflow that can fire on a push is a foot-gun: one bad merge
   * and a broken build is on the registry forever. `ci.yml` carries a
   * comment saying exactly that; this is the same claim, checked as an
   * absence rather than trusted as a comment nobody re-reads before adding a
   * second trigger next to the first.
   */
  it("never fires on a push, a pull request, or a manual dispatch", () => {
    const on = topLevelOnBlock(workflow);
    for (const trigger of ["push", "pull_request", "workflow_dispatch", "schedule"]) {
      expect(on, `release.yml's on: block should not mention ${trigger}`).not.toMatch(
        new RegExp(`^\\s*${trigger}\\s*:`, "m"),
      );
    }
  });
});

describe("the ClawHub publish step", () => {
  /**
   * `clawhub` resolves a relative folder argument against its own working
   * directory, which silently falls back to the OpenClaw workspace directory
   * when the current directory has no `.clawhub/` marker: `publish .` would
   * upload the wrong directory and then report `SKILL.md required` about a
   * directory nobody named. `GITHUB_WORKSPACE` is the absolute path GitHub
   * Actions guarantees for the checkout, so it is the one argument this
   * cannot happen to.
   */
  it("publishes GITHUB_WORKSPACE as an absolute path", () => {
    expect(workflow).toContain('skill publish "$GITHUB_WORKSPACE"');
  });

  it("never publishes a bare relative path", () => {
    // Anchored on `npx clawhub`, not just the words `skill publish`: the
    // comment above this step names the subcommand too (explaining the trap
    // this test guards against), and a looser match found that comment
    // instead of the invocation, passing regardless of what the invocation
    // below it actually said.
    const publishLine = workflow.split("\n").find((line) => line.includes("npx clawhub"));
    expect(publishLine, "no `npx clawhub ... skill publish` invocation found in release.yml").toBeDefined();
    // Catches both `publish .` and `publish "."`: a bare dot, quoted or not,
    // immediately after the subcommand, with nothing before it that would
    // make it absolute.
    expect(publishLine).not.toMatch(/skill publish\s+"?\."?(?:\s|$)/);
  });
});

describe("the drift check's position in the release job", () => {
  /**
   * Same defect class as the one `src/docs.test.ts` already pins for
   * `ci.yml`: `npm test`'s `pretest` script runs `npm run build`, which
   * overwrites `lib/` from `src/`. If the drift check ran after Typecheck or
   * Test, it would compare a fresh build in a temporary directory to a fresh
   * build already sitting in the working tree, from the same source, which
   * always matches regardless of whether the *committed* `lib/`, the
   * directory this job is about to publish, ever agreed with `src/` at all.
   * That would make the release workflow publish a bundle whose committed
   * output does not match its source without ever failing on it, which is
   * the exact lie the drift check exists to catch.
   */
  it("runs before Typecheck or Test can rebuild lib/", () => {
    const driftCheck = workflow.indexOf("name: Assert lib/ matches a fresh build of src/");
    const typecheck = workflow.indexOf("name: Typecheck");
    const test = workflow.indexOf("name: Test");
    expect(driftCheck, "the drift-check step is missing").toBeGreaterThan(-1);
    for (const [label, index] of [["Typecheck", typecheck], ["Test", test]] as const) {
      expect(index, `the ${label} step is missing`).toBeGreaterThan(-1);
      expect(driftCheck, `the drift check must run before ${label}, which can rebuild lib/`).toBeLessThan(index);
    }
  });
});
