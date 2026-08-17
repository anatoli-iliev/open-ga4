import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./testing/files.test-support.js";

/**
 * `.github/workflows/release.yml` is the only place in this repository that
 * can put a listing on ClawHub. Several properties of it would fail silently
 * and expensively if a future edit undid them, and none would be caught by
 * anything else in the suite (nothing here runs the workflow itself; GitHub
 * Actions is not something `npm test` can execute), so they are pinned as
 * assertions against the committed YAML: most as text matches, the same
 * technique `src/docs.test.ts` already uses on `ci.yml`, and the version
 * guard by actually running the shell script the workflow would run, since a
 * regex embedded in someone else's `run:` block deserves the same scrutiny as
 * one written directly in a test.
 *
 * Not pinned here, considered and rejected: that the action SHAs match
 * `ci.yml`'s (a drift there is a maintenance nuisance, not a silent one:
 * Dependabot's weekly PR would still show a divergent pin, and a security
 * scan would still catch an unpinned or stale action; it does not put a
 * wrong bundle on the registry the way the properties below do).
 */

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

/**
 * A top-level block scalar key (`on:`, `permissions:`), isolated from
 * whatever follows it at the same or a shallower indentation. Scanning the
 * whole file for, say, `push:` would also match nothing today, which is
 * exactly why isolating the block matters: a future step that legitimately
 * needed to `git push` or reference a `push` variable should not make a test
 * about the trigger start failing for an unrelated reason.
 */
function topLevelBlock(yaml: string, key: string): string {
  const match = new RegExp(`^${key}:\\n([\\s\\S]*?)(?=\\n\\S)`, "m").exec(yaml);
  if (!match) {
    throw new Error(`no top-level ${key}: block found`);
  }
  return match[1]!;
}

describe("the release workflow's trigger", () => {
  it("fires on a published release and nothing else", () => {
    const on = topLevelBlock(workflow, "on");
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
    const on = topLevelBlock(workflow, "on");
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

describe("the ClawHub tag for a prerelease", () => {
  /**
   * GitHub fires `release: published` for prereleases too: `prereleased` is
   * a separate event type that exists alongside `published`, not instead of
   * it, so checking "this is a pre-release" in the GitHub UI does not stop
   * this workflow from running. The publish step used to hardcode
   * `--tags latest`, which would have aliased a beta as the default
   * `openclaw skills install @anatoli-iliev/open-ga4` gets.
   *
   * This pins the fix at the one line that computes the tag, rather than
   * scanning the whole file for the words "tags" and "latest": the file's
   * own comments explain this exact failure mode in prose next to the fix,
   * using those same words, and a looser scan would have matched its own
   * explanation instead of the code.
   */
  it("computes the tag from github.event.release.prerelease, and only the non-prerelease branch is latest", () => {
    const tagLine = workflow.split("\n").find((line) => line.includes("CLAWHUB_TAGS:"));
    expect(tagLine, "no CLAWHUB_TAGS assignment found in release.yml").toBeDefined();
    const match = /github\.event\.release\.prerelease\s*&&\s*'([^']+)'\s*\|\|\s*'([^']+)'/.exec(tagLine!);
    expect(match, "CLAWHUB_TAGS is not computed from github.event.release.prerelease").not.toBeNull();
    const [, prereleaseTag, defaultTag] = match!;
    expect(defaultTag, "a real release must still be tagged latest").toBe("latest");
    expect(prereleaseTag, "a prerelease must never be tagged latest").not.toBe("latest");
  });
});

/**
 * The exact shell script inside a named step's `run: |` block, dedented back
 * to what a shell would see. This is the mechanism that lets the version
 * guard below actually execute what the workflow would execute, rather than
 * asserting that some text resembling a semver check is present somewhere in
 * the file: a regex written once here and a second, possibly-drifted one
 * embedded in the YAML would both pass a text-matching test while agreeing
 * with each other and disagreeing with reality.
 */
function stepRunScript(yaml: string, stepName: string): string {
  const lines = yaml.split("\n");
  const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (nameIndex === -1) {
    throw new Error(`no step named "${stepName}" found in release.yml`);
  }
  const runIndex = lines.findIndex((line, i) => i > nameIndex && line.trim() === "run: |");
  if (runIndex === -1) {
    throw new Error(`step "${stepName}" has no "run: |" block`);
  }
  const baseIndent = /^(\s*)/.exec(lines[runIndex]!)![1]!.length;
  const contentIndent = baseIndent + 2;
  const scriptLines: string[] = [];
  for (let i = runIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      scriptLines.push("");
      continue;
    }
    const indent = /^(\s*)/.exec(line)![1]!.length;
    if (indent < contentIndent) {
      break;
    }
    scriptLines.push(line.slice(contentIndent));
  }
  return scriptLines.join("\n");
}

/** Runs `script` in bash with GITHUB_REF_NAME set, the way the step would see it. */
function runVersionGuard(refName: string): { status: number; output: string } {
  const script = stepRunScript(workflow, "Validate the release version");
  try {
    const stdout = execFileSync("bash", ["-c", script], {
      env: { ...process.env, GITHUB_REF_NAME: refName },
      encoding: "utf8",
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("the release version guard", () => {
  /**
   * `--version "${GITHUB_REF_NAME#v}"` only strips a leading `v`; whatever is
   * left reaches `clawhub skill publish` unvalidated. Whether ClawHub itself
   * rejects a malformed version is server-side and not something this
   * repository can test or assume, so this step exists to fail first,
   * naming the exact bad tag, before anything reaches the registry to find
   * out. Prerelease and build-metadata suffixes are both accepted, because a
   * real prerelease version string (`1.2.3-beta.1`) is a different thing
   * from the `prerelease` checkbox tested above: a tag can be plain `v1.2.3`
   * and still be flagged as a pre-release in the GitHub UI.
   *
   * Executes the actual script from `release.yml`, not a copy of it: see
   * `stepRunScript` above for why a second regex written here would not have
   * caught the two disagreeing.
   */
  it("accepts a plain release version", () => {
    const result = runVersionGuard("v1.2.3");
    expect(result.status, result.output).toBe(0);
  });

  it("accepts a version with a prerelease and build suffix", () => {
    const result = runVersionGuard("v1.2.3-beta.1+build.5");
    expect(result.status, result.output).toBe(0);
  });

  it("rejects a two-segment tag, naming it", () => {
    const result = runVersionGuard("v1.0");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("v1.0");
  });

  it("rejects a non-numeric tag, naming it", () => {
    const result = runVersionGuard("release-aug");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("release-aug");
  });

  it("rejects a version with a leading zero", () => {
    const result = runVersionGuard("v01.2.3");
    expect(result.status).not.toBe(0);
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

describe("workflow permissions stay minimal", () => {
  /**
   * Disclosed as a gap in this workflow's own first review: nothing pinned
   * that `permissions: contents: read` stays the only permission granted. A
   * future change adding, say, `contents: write` for a step that does not
   * need it would have passed every other test in this suite. `ci.yml`
   * carries the identical unpinned risk, so both files are checked here
   * rather than only the one this task added, so the two cannot drift apart
   * on this.
   */
  for (const file of [".github/workflows/release.yml", ".github/workflows/ci.yml"]) {
    it(`${file} grants only contents: read`, () => {
      const yaml = readFileSync(path.join(repoRoot, file), "utf8");
      const block = topLevelBlock(yaml, "permissions");
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(lines).toEqual(["contents: read"]);
    });
  }
});
