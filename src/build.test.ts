import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listFiles, repoRoot, SHIPPED_DOCS } from "./testing/files.test-support.js";

/**
 * Structural checks on `lib/`, the compiled JavaScript committed alongside
 * `src/` because no install route runs a build (ClawHub copies files,
 * `git:` clones, a local path is a directory copy). `scripts/build-lib.mjs`
 * is what produces this tree, `npm run check:lib` is what proves the
 * committed copy still matches a fresh build, and `src/privacy/surface.test.ts`
 * checks what the tree contains for the privacy guarantees. This file checks
 * the two things a corrupted or half-finished build could get wrong that
 * are not privacy claims: that a test never ships, and that the documented
 * entry point exists.
 */

const libDir = path.join(repoRoot, "lib");

describe("lib/, the committed build output", () => {
  it("has a runnable entry point at lib/cli.js", () => {
    expect(existsSync(path.join(libDir, "cli.js"))).toBe(true);
  });

  it("ships no compiled tests", () => {
    expect(listFiles(libDir, ".test.js")).toEqual([]);
    expect(listFiles(libDir, ".test.d.ts")).toEqual([]);
  });

  it("ships nothing from src/testing/", () => {
    const offenders = [...listFiles(libDir, ".js"), ...listFiles(libDir, ".d.ts")]
      .map((file) => path.relative(libDir, file))
      .filter((rel) => rel.split(path.sep).includes("testing"));
    expect(offenders).toEqual([]);
  });
});

/**
 * `.clawhubignore` decides what the published bundle contains, and both
 * directions of that decision are deliberate.
 *
 * Excluded: everything that exists only to develop this repository.
 * node_modules/ is named explicitly rather than assumed, because
 * .github/workflows/release.yml publishes after `npm ci`, so it is present in
 * the directory being published and whether the publisher happens to skip it
 * is not something this repository controls.
 *
 * Included, on purpose: src/, minus its tests. The auditability claim is the
 * product and ClawHub's security review reads the shipped code, so the source
 * that compiles to lib/ ships next to it.
 *
 * Excluded as of 0.2.0, having previously shipped: *.test.ts and src/testing/.
 * The tests were never runnable from an installed copy, because the runner's
 * configuration and two paths those tests read are excluded, so they shipped to
 * be read. ClawHub's static analysis then read them and reported four CRITICAL
 * findings against the bundle, all four false positives in test files: two
 * child_process calls that exercise this repository's own machinery, and two
 * deliberately fake credential fixtures that the redaction tests cannot do
 * without. The tests are in the public repository, where they run.
 */
describe(".clawhubignore, which decides what is published", () => {
  const ignorePath = path.join(repoRoot, ".clawhubignore");

  function patterns(): string[] {
    return readFileSync(ignorePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
  }

  it("exists", () => {
    expect(existsSync(ignorePath)).toBe(true);
  });

  it("says where the tests went, now that they do not ship", () => {
    // Two earlier versions of this file each claimed something the patterns
    // contradicted: first that everything needed to "run or audit" the skill
    // shipped, while the runner's configuration was excluded, then that the
    // suite shipped "to be read, not to be run", which stopped being true when
    // the suite stopped shipping. A reader who goes looking for a test named in
    // PRIVACY.md needs the header to tell them where it actually is.
    const text = readFileSync(ignorePath, "utf8");
    if (patterns().includes("*.test.ts")) {
      expect(text, "the tests are excluded, so the header must say where they are instead")
        .toMatch(/public repositor|in the repositor/i);
      expect(text, "the header must not still claim the suite ships")
        .not.toMatch(/to be read, not to be run/i);
    }
  });

  it("excludes everything that only exists to develop the skill", () => {
    for (const pattern of [
      "node_modules/",
      ".git/",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.check.json",
      "vitest.config.ts",
      "scripts/",
      ".github/",
      ".superpowers/",
      "docs/superpowers/",
      "*.test.ts",
      "src/testing/",
    ]) {
      expect(patterns(), `${pattern} should not be published`).toContain(pattern);
    }
  });

  it("excludes nothing a user or a reviewer needs", () => {
    const mustShip = ["src/", "lib/", "package.json", ...SHIPPED_DOCS];
    for (const pattern of patterns()) {
      for (const kept of mustShip) {
        expect(pattern, `${kept} must stay in the published bundle`).not.toBe(kept);
        expect(pattern, `${kept} must stay in the published bundle`)
          .not.toBe(kept.replace(/\/$/, ""));
        // A directory pattern excludes everything under it, so `docs/` would
        // take docs/DESIGN.md with it while matching neither check above.
        if (pattern.endsWith("/")) {
          expect(kept.startsWith(pattern), `${pattern} would exclude ${kept}`).toBe(false);
        }
      }
    }
  });

  /**
   * Whether a path is published, answered by walking the repository against the
   * patterns rather than by pattern-matching the patterns themselves. The
   * previous version of these checks asserted that no pattern contained the
   * word "test", which encoded the decision that the suite shipped; once that
   * decision was reversed the assertion had nothing left to say about whether
   * the right files stopped shipping, which is the part worth defending.
   *
   * Purpose-built for the pattern shapes this file uses, and used only for paths
   * under src/: a trailing-slash directory prefix, a leading-`*` glob matched
   * against the basename the way gitignore matches a pattern containing no
   * slash, and an exact path. Not a general gitignore implementation, which is
   * why the control test below pins it against known answers: a matcher that
   * quietly stopped matching would make everything past it pass forever.
   */
  function isExcluded(relPath: string): boolean {
    return patterns().some((pattern) => {
      if (pattern.endsWith("/")) {
        return relPath === pattern.slice(0, -1) || relPath.startsWith(pattern);
      }
      if (pattern.startsWith("*")) {
        return path.basename(relPath).endsWith(pattern.slice(1));
      }
      return relPath === pattern;
    });
  }

  it("has a matcher that recognises the shapes actually in the file", () => {
    expect(isExcluded("src/privacy/redact.test.ts"), "*.test.ts, at depth").toBe(true);
    expect(isExcluded("src/testing/files.test-support.ts"), "src/testing/").toBe(true);
    expect(isExcluded("src/privacy/redact.ts"), "ordinary source").toBe(false);
    expect(isExcluded("lib/cli.js"), "the built output").toBe(false);
    expect(isExcluded("PRIVACY.md"), "a shipped doc").toBe(false);
    expect(isExcluded("tsconfig.json"), "an exact path").toBe(true);
  });

  it("publishes every source file that is not a test", () => {
    const shipped = listFiles(path.join(repoRoot, "src"), ".ts")
      .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
      .filter((rel) => !rel.endsWith(".test.ts") && !rel.startsWith("src/testing/"));
    // Guard against the glob above matching nothing and vacuously passing.
    expect(shipped.length, "src/ should hold source files that are not tests").toBeGreaterThan(15);
    const dropped = shipped.filter((rel) => isExcluded(rel));
    expect(dropped, "the source that compiles to lib/ has to ship for the code to be auditable")
      .toEqual([]);
  });

  it("publishes no test file", () => {
    const tests = listFiles(path.join(repoRoot, "src"), ".ts")
      .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
      .filter((rel) => rel.endsWith(".test.ts") || rel.startsWith("src/testing/"));
    expect(tests.length, "src/ should still hold a test suite").toBeGreaterThan(20);
    const leaked = tests.filter((rel) => !isExcluded(rel));
    expect(leaked, "these would be published, and a scanner reads a test fixture as a finding")
      .toEqual([]);
  });

  /**
   * `.gitignore` and `.clawhubignore` answer two different questions, and only
   * one of them decides what leaves the machine.
   *
   * `.gitignore` excludes `*.pem`, `*.key`, `*-key.json`,
   * `*service-account*.json`, gcloud's application-default credentials file and
   * `.env*`, under a comment saying the block exists so an accidental
   * `git add .` cannot leak a Google service-account key. `.clawhubignore`
   * repeated none of them, while its own header argues that exclusions must be
   * named explicitly rather than assumed.
   *
   * Nothing is exposed by that today: no file matching those patterns is in the
   * repository, and the release workflow publishes a clean CI checkout. It
   * matters for the local form the header of `.clawhubignore` documents,
   * `clawhub skill publish "$PWD"`, which uploads whatever working tree it is
   * pointed at. A key file dropped in the checkout during setup or while
   * reproducing a bug is exactly the case where git refuses the commit and the
   * registry takes the upload.
   *
   * Derived from `.gitignore` rather than listed here, because a list is a
   * second place to forget: adding `*.p12` to that block and not to
   * `.clawhubignore` fails this. Two deliberate costs come with deriving it.
   * Anything else appended to that block of `.gitignore` has to be considered
   * for the bundle too, which is the decision this test exists to force rather
   * than a false alarm. And the block is found by the wording of the comment
   * above it, so rewording that comment fails this test: the message says so,
   * and the fix is to keep the phrase or to change it here as well.
   */
  describe("agrees with .gitignore about credentials", () => {
    /**
     * The patterns in `.gitignore`'s credential block: from the comment that
     * introduces it to the next blank line, comments dropped. Negations
     * (`!.env.example`) are dropped as well, since a negation re-includes a
     * file rather than excluding one, and `.clawhubignore` documents why it
     * does not mirror that line.
     */
    function gitignoreCredentialPatterns(): string[] {
      const lines = readFileSync(path.join(repoRoot, ".gitignore"), "utf8").split("\n");
      const start = lines.findIndex((line) => line.includes("Never commit credentials"));
      expect(start, ".gitignore has no credential block to compare against").toBeGreaterThan(-1);
      const collected: string[] = [];
      for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        if (trimmed === "") break;
        if (trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("!")) continue;
        collected.push(trimmed);
      }
      return collected;
    }

    it("reads a credential block out of .gitignore that is worth comparing", () => {
      // A parser that silently matched nothing would make the test below pass
      // forever, which is the failure mode of every test that derives its
      // expectations from a file.
      const found = gitignoreCredentialPatterns();
      expect(found.length).toBeGreaterThan(4);
      for (const shape of ["*.pem", "*service-account*.json", ".env"]) {
        expect(found, `.gitignore's credential block should still exclude ${shape}`).toContain(shape);
      }
    });

    it("excludes every pattern .gitignore excludes as a credential", () => {
      const missing = gitignoreCredentialPatterns().filter((pattern) => !patterns().includes(pattern));
      expect(missing, "these are kept out of git but would still be published").toEqual([]);
    });
  });

  /**
   * `.github/publish/` holds the pinned install of the ClawHub publisher: a
   * `package.json` and a committed `package-lock.json` so the step that holds
   * the release credential runs a recorded dependency tree rather than one
   * resolved at release time. It is release tooling, so it stays out of the
   * bundle, and `npm ci` there puts a second `node_modules` in the directory
   * being published.
   *
   * Both are already covered, by `.github/` and by `node_modules/`. This exists
   * so narrowing `.github/` to `.github/workflows/` some day, which looks like a
   * harmless tightening, cannot quietly start shipping them.
   */
  it("excludes the release publisher's pinned install", () => {
    for (const file of [".github/publish/package.json", ".github/publish/package-lock.json"]) {
      const covering = patterns().filter((pattern) => pattern.endsWith("/") && file.startsWith(pattern));
      expect(covering, `${file} is release tooling and must not be published`).not.toEqual([]);
    }
    expect(patterns(), "npm ci in .github/publish/ creates a second node_modules")
      .toContain("node_modules/");
  });
});
