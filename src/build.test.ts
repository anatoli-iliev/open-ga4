import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listFiles, repoRoot } from "./testing/files.test-support.js";

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
