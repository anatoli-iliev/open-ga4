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
 * Included, on purpose: src/ and its tests. The auditability claim is the
 * product, ClawHub's security review reads the shipped code, and
 * src/privacy/surface.test.ts is the artifact that proves the privacy claims
 * rather than asserting them. An "exclude every test" tidy-up would delete
 * exactly the file the README points a sceptical reader at.
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
    // No pattern may reach into src/, and no pattern may exclude test files:
    // a future "do not ship tests" tidy-up has to argue with this test first,
    // because the file it would delete is the one the README points a
    // sceptical reader at. vitest.config.ts is the one allowed match on
    // "test", and it is configuration, not a test.
    for (const pattern of patterns()) {
      expect(pattern, "no pattern may exclude anything under src/").not.toMatch(/(^|\/)src(\/|$)/);
      if (pattern !== "vitest.config.ts") {
        expect(pattern, "test files ship on purpose").not.toMatch(/test/i);
      }
    }
  });
});
