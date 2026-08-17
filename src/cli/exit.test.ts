import { describe, expect, it } from "vitest";
import { Ga4Error } from "../ga4/errors.js";
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

  it("maps anything that is not a Ga4Error to exit 1, unexpected", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(EXIT.UNEXPECTED);
    expect(exitCodeFor("a string")).toBe(EXIT.UNEXPECTED);
    expect(exitCodeFor(undefined)).toBe(EXIT.UNEXPECTED);
  });
});
