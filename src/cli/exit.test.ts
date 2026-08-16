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

  it("maps NO_CREDENTIALS to exit 3, not exit 4", () => {
    // src/runtime.ts still raises NO_CREDENTIALS (a later task collapses it
    // into CREDENTIALS_MISSING). Until then this must not read as "Google
    // refused a request" when the real problem is an unfinished setup.
    expect(exitCodeFor(ga4Error("NO_CREDENTIALS"))).toBe(EXIT.SETUP_INCOMPLETE);
  });

  it("maps an invalid request to exit 2, not exit 4", () => {
    expect(exitCodeFor(ga4Error("INVALID_REQUEST"))).toBe(EXIT.BAD_INPUT);
  });

  it("maps any other Ga4Error to exit 4, Google refused", () => {
    expect(exitCodeFor(ga4Error("QUOTA_EXHAUSTED"))).toBe(EXIT.GOOGLE_REFUSED);
    expect(exitCodeFor(ga4Error("GOOGLE_SERVER_ERROR"))).toBe(EXIT.GOOGLE_REFUSED);
    expect(exitCodeFor(ga4Error("UNEXPECTED"))).toBe(EXIT.GOOGLE_REFUSED);
  });

  it("maps anything that is not a Ga4Error to exit 1, unexpected", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(EXIT.UNEXPECTED);
    expect(exitCodeFor("a string")).toBe(EXIT.UNEXPECTED);
    expect(exitCodeFor(undefined)).toBe(EXIT.UNEXPECTED);
  });
});
