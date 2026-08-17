import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ga4Error } from "../ga4/errors.js";
import { shippedSources } from "../testing/files.test-support.js";
import { EXIT, exitCodeFor } from "./exit.js";

function ga4Error(code: string): Ga4Error {
  return new Ga4Error(code, "message", "fix");
}

describe("EXIT", () => {
  it("assigns one code per meaning", () => {
    expect(EXIT).toEqual({
      OK: 0,
      UNEXPECTED: 1,
      BAD_INPUT: 2,
      SETUP_INCOMPLETE: 3,
      GOOGLE_REFUSED: 4,
    });
  });
});

describe("exitCodeFor", () => {
  it("maps every setup-incomplete code to exit 3", () => {
    const setupCodes = [
      "CREDENTIALS_MISSING",
      "CREDENTIALS_REJECTED",
      "CLOCK_SKEW",
      "DATA_API_DISABLED",
      "ADMIN_API_DISABLED",
      "NO_PROPERTY_ACCESS",
      "NO_PROPERTY",
      "PROPERTY_NOT_FOUND",
    ];
    for (const code of setupCodes) {
      expect(exitCodeFor(ga4Error(code))).toBe(EXIT.SETUP_INCOMPLETE);
    }
  });

  it("maps an invalid request to exit 2, not exit 4", () => {
    expect(exitCodeFor(ga4Error("INVALID_REQUEST"))).toBe(EXIT.BAD_INPUT);
  });

  it("maps any other Ga4Error to exit 4, Google refused", () => {
    expect(exitCodeFor(ga4Error("QUOTA_EXHAUSTED"))).toBe(EXIT.GOOGLE_REFUSED);
    expect(exitCodeFor(ga4Error("GOOGLE_SERVER_ERROR"))).toBe(EXIT.GOOGLE_REFUSED);
  });

  it("maps a blocked egress attempt to exit 1: it is a defect, not an answer", () => {
    // The egress guard refuses before a socket is opened, and every URL this
    // skill builds comes from constants in its own source, so reaching it
    // means the skill tried to contact somewhere it may not. Exit 4 would
    // blame Google for a request it never received; exit 2 would ask the user
    // to correct a value they never supplied.
    expect(exitCodeFor(ga4Error("EGRESS_BLOCKED"))).toBe(EXIT.UNEXPECTED);
  });

  it("maps UNEXPECTED to exit 1, not to exit 4", () => {
    // diagnose()'s catch-all for a failure it could not name is the one code
    // that is not a statement about Google's answer, so it must not claim
    // Google refused anything. It is also what makes exit 1 reachable at all:
    // everything reaching exitCodeFor has already been converted to a
    // Ga4Error, so the non-Ga4Error branch below is a belt-and-braces path.
    expect(exitCodeFor(ga4Error("UNEXPECTED"))).toBe(EXIT.UNEXPECTED);
  });

  it("can return every code EXIT defines", () => {
    // SKILL.md documents all five, and an agent reads that table to decide
    // what to tell somebody. Exit 1 was documented and unreachable for the
    // whole project, because everything reaching here is a Ga4Error and every
    // Ga4Error that was not a setup code or INVALID_REQUEST fell into exit 4.
    // A documented code nothing can return is a promise about behaviour that
    // does not exist, so the set is asserted rather than the entries.
    const produced = new Set([
      EXIT.OK,
      ...["CREDENTIALS_MISSING", "INVALID_REQUEST", "UNEXPECTED", "QUOTA_EXHAUSTED"].map((code) =>
        exitCodeFor(ga4Error(code)),
      ),
    ]);
    expect(produced).toEqual(new Set(Object.values(EXIT)));
  });

  /**
   * Every Ga4Error code the shipped source can raise, scanned from it rather
   * than listed here.
   *
   * Deliberately narrow. Ga4RequestError carries a second vocabulary in its
   * `reason` field (EMPTY_REQUEST, TOO_MANY_DIMENSIONS, BAD_FILTER_VALUE and
   * so on) which looks identical to a code and is not one, so this matches
   * only the positions a code can actually occupy: the first argument to
   * `new Ga4Error(...)` or to a subclass's `super(...)`, the `code:` field of
   * an options object, and the fallback in `options.code ?? "..."`.
   */
  function raisedCodes(): Set<string> {
    const codes = new Set<string>();
    const patterns = [
      /new Ga4Error\(\s*"([A-Z_]+)"/g,
      /super\(\s*"([A-Z_]+)"/g,
      /\bcode:\s*"([A-Z_]+)"/g,
      /\?\?\s*"([A-Z_]+)"/g,
    ];
    for (const file of shippedSources()) {
      const text = readFileSync(file, "utf8");
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          codes.add(match[1]!);
        }
      }
    }
    return codes;
  }

  /**
   * What each code exits with, decided once and written down. A code missing
   * from here fails the test rather than silently inheriting exit 4, which is
   * how "Google refused" ended up attached to failures Google never saw. Two
   * documents describe this mapping in prose (SKILL.md's table and
   * CHANGELOG.md's note), and both were wrong about it at different points in
   * this branch precisely because nothing forced the question to be asked.
   */
  const DECIDED: Readonly<Record<string, number>> = {
    // Setup is unfinished: exit 3.
    CREDENTIALS_MISSING: EXIT.SETUP_INCOMPLETE,
    CREDENTIALS_REJECTED: EXIT.SETUP_INCOMPLETE,
    CLOCK_SKEW: EXIT.SETUP_INCOMPLETE,
    DATA_API_DISABLED: EXIT.SETUP_INCOMPLETE,
    ADMIN_API_DISABLED: EXIT.SETUP_INCOMPLETE,
    NO_PROPERTY_ACCESS: EXIT.SETUP_INCOMPLETE,
    NO_PROPERTY: EXIT.SETUP_INCOMPLETE,
    PROPERTY_NOT_FOUND: EXIT.SETUP_INCOMPLETE,
    // The query has to change, whoever worked that out: exit 2.
    INVALID_REQUEST: EXIT.BAD_INPUT,
    // A defect, not an answer: exit 1.
    UNEXPECTED: EXIT.UNEXPECTED,
    EGRESS_BLOCKED: EXIT.UNEXPECTED,
    // Google said no for a reason that is not about the query: exit 4.
    QUOTA_EXHAUSTED: EXIT.GOOGLE_REFUSED,
    GOOGLE_SERVER_ERROR: EXIT.GOOGLE_REFUSED,
  };

  it("gives every code the shipped source raises an exit code somebody decided", () => {
    const codes = raisedCodes();
    // Guard against a scan that quietly matches nothing and passes forever.
    expect(codes.size).toBeGreaterThanOrEqual(10);
    for (const known of ["CREDENTIALS_MISSING", "INVALID_REQUEST", "EGRESS_BLOCKED", "PROPERTY_NOT_FOUND"]) {
      expect(codes, `the scan should have found ${known}`).toContain(known);
    }

    for (const code of codes) {
      expect(DECIDED[code], `${code} has no decided exit code; add it above rather than letting it default`)
        .toBeDefined();
      expect(exitCodeFor(ga4Error(code)), `${code}`).toBe(DECIDED[code]);
    }
  });

  it("maps anything that is not a Ga4Error to exit 1, unexpected", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(EXIT.UNEXPECTED);
    expect(exitCodeFor("a string")).toBe(EXIT.UNEXPECTED);
    expect(exitCodeFor(undefined)).toBe(EXIT.UNEXPECTED);
  });
});
